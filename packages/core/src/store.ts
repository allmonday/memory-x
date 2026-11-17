import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNode } from "./types.ts";

export const STORE_DIR = ".memory";
export const DB_FILE = "memory.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  depth INTEGER NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, ord);
CREATE TABLE IF NOT EXISTS leaves(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leaves_node ON leaves(node_id, ord);
`;

interface NodeRow {
  id: number;
  parent_id: number | null;
  ord: number;
  title: string;
  path: string;
  depth: number;
  content: string | null;
}

/**
 * SQLite 存储层（B 案）：nodes 表为操作真相源。
 * 每个节点带物化的完整链路 path（重名兄弟自动 [n] 消歧），
 * content 字段承载节点完整信息（RAG 语料）。
 *
 * 写入策略：整树重写（单事务）。个人记忆规模（≤万级节点）下
 * 全量重建是毫秒级操作，换取与内存树的绝对一致，无增量同步 bug 面。
 * WAL 模式保证崩溃安全。
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  readonly dbPath: string;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
  }

  static open(dir: string): MemoryStore {
    mkdirSync(join(dir, STORE_DIR), { recursive: true });
    return new MemoryStore(join(dir, STORE_DIR, DB_FILE));
  }

  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number };
    return row.n === 0;
  }

  loadTree(): MemoryNode {
    const nodeRows = this.db
      .prepare("SELECT id, parent_id, ord, title, path, depth, content FROM nodes ORDER BY depth, ord, id")
      .all() as NodeRow[];
    if (nodeRows.length === 0) return { title: "Memory", leaves: [], children: [] };

    const leafRows = this.db
      .prepare("SELECT node_id, ord, text FROM leaves ORDER BY node_id, ord, id")
      .all() as { node_id: number; ord: number; text: string }[];

    const byId = new Map<number, MemoryNode & { __id: number; __parent: number | null }>();
    for (const r of nodeRows) {
      byId.set(r.id, {
        title: r.title,
        leaves: [],
        content: r.content,
        children: [],
        __id: r.id,
        __parent: r.parent_id,
      });
    }
    for (const l of leafRows) {
      byId.get(l.node_id)?.leaves.push(l.text);
    }

    let root: (MemoryNode & { __id: number; __parent: number | null }) | undefined;
    for (const r of nodeRows) {
      const node = byId.get(r.id)!;
      if (r.parent_id === null) {
        root = node;
      } else {
        byId.get(r.parent_id)?.children.push(node);
      }
    }
    if (!root) throw new Error("存储损坏：找不到根节点（parent_id 为 NULL 的记录缺失）");
    const clean = (n: MemoryNode & { __id: number; __parent: number | null }): MemoryNode => ({
      title: n.title,
      leaves: n.leaves,
      content: n.content,
      children: n.children.map(clean),
    });
    return clean(root);
  }

  /** 整树重写（单事务）。path 物化：重名兄弟追加 [k]（k≥2）。 */
  saveTree(root: MemoryNode): void {
    const insertNode = this.db.prepare(
      "INSERT INTO nodes(parent_id, ord, title, path, depth, content) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertLeaf = this.db.prepare("INSERT INTO leaves(node_id, ord, text) VALUES (?, ?, ?)");

    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM leaves");
      this.db.exec("DELETE FROM nodes");

      const walk = (node: MemoryNode, parentId: number | null, parentPath: string, depth: number): number => {
        let ord = 0;
        const titleCount = new Map<string, number>();
        for (const child of node.children) {
          const seen = (titleCount.get(child.title) ?? 0) + 1;
          titleCount.set(child.title, seen);
          const seg = seen > 1 ? `${child.title}[${seen}]` : child.title;
          const path = parentPath === "" ? seg : `${parentPath}/${seg}`;
          const info = insertNode.run(parentId, ord++, child.title, path, depth, child.content ?? null);
          const id = Number(info.lastInsertRowid);
          for (let i = 0; i < child.leaves.length; i++) {
            insertLeaf.run(id, i, child.leaves[i]!);
          }
          walk(child, id, path, depth + 1);
        }
        return ord;
      };
      const rootInfo = insertNode.run(null, 0, root.title, "", 0, root.content ?? null);
      const rootId = Number(rootInfo.lastInsertRowid);
      for (let i = 0; i < root.leaves.length; i++) {
        insertLeaf.run(rootId, i, root.leaves[i]!);
      }
      walk(root, rootId, "", 1);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 供检索层：按 path 前缀查节点（含完整链路）。 */
  findByPathPrefix(prefix: string): NodeRow[] {
    return this.db
      .prepare("SELECT * FROM nodes WHERE path = ? OR path LIKE ? ORDER BY depth, ord")
      .all(prefix, `${prefix}/%`) as NodeRow[];
  }

  close(): void {
    this.db.close();
  }
}
