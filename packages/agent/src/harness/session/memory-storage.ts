import {
	type LeafEntry,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * 此方法用于更新指定 Entry 的标签，包含新增标签和删除标签两种行为。
 * @param labelsById 
 * @param entry 
 * @returns 
 */
function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;  // 跳过处理非 label 的entry
	const label = entry.label?.trim();
	if (label) {
		// LabelEntry 的标签不为空，则给指定 Entry 设置标签
		labelsById.set(entry.targetId, label);
	} else {
		// LabelEntry 的label为空，则删除指定 Entry 的标签关系
		labelsById.delete(entry.targetId);
	}
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv7().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

/**
 * 根据当前Entry，返回实际叶子节点的ID。
 * 只有两个规则：
 * - 普通条目（message、model_change 等）：追加后，`leafId` = 该条目的 `id`（新条目成为新叶子）
 * - LeafEntry条目：一次导航跳转记录，追加后，`leafId` = `entry.targetId`（leaf 条目本身不成为叶子，它只是"指针"，指向真正的目标）。
 * @param entry 
 * @returns 
 */
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

/**
 * 基于内存Map实现的会话管理类。
 * 最重要的是 getPathToRoot() 方法。
 */
export class InMemorySessionStorage<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionStorage<TMetadata>
{
	private readonly metadata: TMetadata;
	// 存储所有的 entry 数组
	private entries: SessionTreeEntry[];
	// 存储 Entry.id -> Entry 的内存Map，用于快速查找
	private byId: Map<string, SessionTreeEntry>;

	// 存储 Entry.targetId -> Entry.label 的内存Map，也就是记录每个 Entry 的标签
	private labelsById: Map<string, string>;

	// 这个 leafID 指向的是当前活跃的叶子节点ID。
	private leafId: string | null;

	constructor(options?: { entries?: SessionTreeEntry[]; metadata?: TMetadata }) {
		this.entries = options?.entries ? [...options.entries] : [];
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));

		// 遍历所有节点，根据 LabelEntry 为对应的 Entry 设置标签，方便按照标签进行跳转
		this.labelsById = buildLabelsById(this.entries);

		// 检查并设置当前活跃的叶子节点
		this.leafId = null;
		for (const entry of this.entries) this.leafId = leafIdAfterEntry(entry);
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}

		this.metadata = options?.metadata ?? ({ id: uuidv7(), createdAt: new Date().toISOString() } as TMetadata);
	}

	async getMetadata(): Promise<TMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		return this.leafId;
	}

	/**
	 * 导航跳转会话历史后，设置叶子节点。
	 * 这个跳转行为，专门使用了一个 LeafEntry 记录类型来持久化。
	 * @param leafId 
	 */
	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		// 这个记录类型是为了将此次导航跳转的行为持久化 ------------------------ KEY
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		// 跳转完同步更新叶子节点变量指向
		this.leafId = leafId;
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		this.leafId = leafIdAfterEntry(entry);
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	/**
	 * 这个方法很重要，它是整个会话树导航和上下文重建的基石。
	 * 它支持从 **任意节点** 出发，沿 parentId 链回溯到根，返回从根到目标节点的有序路径。
	 * @param leafId: 虽然名称是leafId，但是含义是将该节点ID作为最终的leaf，进行重建回溯。
	 * @returns 
	 */
	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		// 新建了一个空数组存放回溯路径
		const path: SessionTreeEntry[] = [];
		let current = this.byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		// 从给定节点出发，沿 parentId 链回溯到根，返回从根到目标节点的有序路径。
		while (current) {
			// 数组的unshift()每次将元素添加（就地修改）到头部
			path.unshift(current);
			// 遇到根节点则停止
			if (!current.parentId) break;
			// 沿 parentId 链向上回溯
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return [...this.entries];
	}
}
