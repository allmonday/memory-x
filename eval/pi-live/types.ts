/**
 * pi-live 评测的数据集无关类型（HaluMem / LoCoMo 共用）
 * =====================================================
 * 一个「案例」= 一次沙盒仿真的完整输入：逐 user turn 对话史 + 写入侧金标 +
 * 问答探针。各数据集的 adapter 负责把原生格式装载成本形态。
 */

export interface Probe {
  question: string;
  answer?: string | null;
  /** 对抗题：材料里没有的信息，应拒绝作答而非编造 */
  refuse?: boolean;
  /** 分类标签（分桶统计用），如 HaluMem question_type / LoCoMo category */
  tag?: string;
  /** 证据定位（LoCoMo：dia_id 列表，失败题归因用） */
  evidence?: string[];
  /** 对抗题的诱答（模型答出它即失守） */
  adversarialAnswer?: string;
}

/** 更新对：同一事实的旧表述应被新表述替换（supersede 考核单元）；金标缺失的数据集传空数组 */
export interface ReplacePair {
  old: string;
  neu: string;
}

export interface RecordCase {
  /** user 发言（时间序；assistant 轮不喂——pi 会话里由被测 agent 自己生成回复）；date=对话日期（ISO） */
  turns: Array<{ content: string; date: string | null }>;
  /** 黄金点（非更新）：该被记住的事实 */
  expectRemember: string[];
  /** 更新对：旧值应被替换为新值 */
  expectReplace: ReplacePair[];
  /** 问答探针 */
  probes: Probe[];
}
