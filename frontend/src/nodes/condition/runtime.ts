import { WorkflowNodeType } from '../constants';

const cloneJSON = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const STRING_RIGHT_WORKAROUND_OPERATORS = new Set(['is_empty', 'is_not_empty']);

const resolveLeftSchemaType = (left: any, nodes: any[]): string | undefined => {
  if (left?.type !== 'ref' || !Array.isArray(left.content) || left.content.length < 2) {
    return undefined;
  }
  const source = nodes.find((node) => node.id === String(left.content[0]));
  if (!source) return undefined;

  let schema = source.data?.outputs?.properties?.[String(left.content[1])];
  for (const segment of left.content.slice(2)) {
    schema = schema?.type === 'array'
      ? schema.items
      : schema?.properties?.[String(segment)];
  }
  return typeof schema?.type === 'string' ? schema.type.toLowerCase() : undefined;
};

/**
 * runtime-js 1.0.12 declares string empty/non-empty checks as requiring a
 * string right-hand value even though their handlers only inspect the left
 * side. Supplying an ignored empty string keeps local execution aligned with
 * Dify's null/not-null translation without changing the saved canvas.
 */
const prepareConditionEntry = (entry: any, nodes: any[]): any => {
  const value = entry?.value;
  if (
    !value
    || !STRING_RIGHT_WORKAROUND_OPERATORS.has(String(value.operator || '').toLowerCase())
    || value.right
    || resolveLeftSchemaType(value.left, nodes) !== 'string'
  ) {
    return entry;
  }
  return {
    ...entry,
    value: {
      ...value,
      right: {
        type: 'constant',
        content: '',
        schema: { type: 'string' },
      },
    },
  };
};

const withoutEdgeId = (edge: any): any => {
  const copy = { ...edge };
  delete copy.id;
  return copy;
};

const forwardEdges = (
  sourceNodeID: string,
  sourcePortID: string,
  targets: any[],
): any[] => targets.map((edge) => ({
  ...withoutEdgeId(edge),
  sourceNodeID,
  sourcePortID,
}));

const internalEdge = (
  sourceNodeID: string,
  sourcePortID: string,
  targetNodeID: string,
): any => ({ sourceNodeID, sourcePortID, targetNodeID });

const uniqueNodeId = (base: string, usedIds: Set<string>): string => {
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) candidate = `${base}_${suffix++}`;
  usedIds.add(candidate);
  return candidate;
};

/**
 * A multi-condition branch is rendered through its branch port, while the
 * runtime receives one ordinary condition node per atom.  Give every atom a
 * concrete, non-reserved port key before either the generated node or its
 * edges are produced.  In particular, an old draft may omit `entry.key`;
 * leaving that key undefined makes runtime-js fan out all downstream edges.
 */
const normalizeMultiConditionAtomKey = (
  entry: any,
  branchIndex: number,
  conditionIndex: number,
): string => {
  const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
  const normalizedKey = key.toLowerCase();
  if (key && normalizedKey !== 'else' && normalizedKey !== 'false') return key;
  return `condition_${branchIndex}_${conditionIndex}`;
};

/**
 * Compile the richer multi-condition canvas node into ordinary condition
 * nodes understood by runtime-js. AND branches short-circuit on the first
 * false atom, OR branches on the first true atom, and failed branches continue
 * to the next ELSE-IF before reaching the original ELSE edges.
 */
export const prepareConditionNodesForRuntime = <T extends { nodes?: any[]; edges?: any[] }>(
  schema: T,
): T => {
  if (!Array.isArray(schema.nodes) || !Array.isArray(schema.edges)) return schema;

  const prepared = cloneJSON(schema);
  let nodes = prepared.nodes as any[];
  let edges = prepared.edges as any[];

  nodes = nodes.map((node) => {
    if (
      node.type !== WorkflowNodeType.Condition
      || Array.isArray(node.data?.branch)
      || !Array.isArray(node.data?.conditions)
    ) {
      return node;
    }
    const conditionKeys = new Set<string>();
    const conditions = node.data.conditions.map((entry: any) => {
      const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
      if (!key) throw new Error(`条件节点 ${node.id} 包含无效分支 key`);
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'else' || normalizedKey === 'false') {
        throw new Error(`条件节点 ${node.id} 的分支不能使用保留端口 ${normalizedKey}`);
      }
      if (conditionKeys.has(entry.key)) {
        throw new Error(`条件节点 ${node.id} 包含重复的分支 key: ${entry.key}`);
      }
      conditionKeys.add(entry.key);
      return prepareConditionEntry(entry, nodes);
    });
    return {
      ...node,
      data: {
        ...node.data,
        conditions,
      },
    };
  });

  const multiNodes = nodes.filter((node) => (
    node.type === WorkflowNodeType.MultiCondition
    || (node.type === WorkflowNodeType.Condition && Array.isArray(node.data?.branch))
  ));
  for (const multiNode of multiNodes) {
    const branches = Array.isArray(multiNode.data?.branch) ? multiNode.data.branch : [];
    if (
      branches.length === 0
      || branches.some((branch: any) => (
        !Array.isArray(branch?.conditions) || branch.conditions.length === 0
      ))
    ) {
      throw new Error(`多条件节点 ${multiNode.id} 至少需要一个非空分支`);
    }

    const branchKeys = new Set<string>();
    const usedIds = new Set(nodes.map((node) => String(node.id)));
    let firstAtom = true;
    const descriptors = branches.map((branch: any, branchIndex: number) => {
      if (
        branch.key
        && (typeof branch.key !== 'string' || !branch.key.trim())
      ) {
        throw new Error(`多条件节点 ${multiNode.id} 包含无效分支 key`);
      }
      const branchKey = typeof branch.key === 'string' && branch.key.trim()
        ? branch.key
        : `branch.${branchIndex}`;
      const normalizedBranchKey = branchKey.trim().toLowerCase();
      if (normalizedBranchKey === 'else' || normalizedBranchKey === 'false') {
        throw new Error(
          `多条件节点 ${multiNode.id} 的分支不能使用保留端口 ${normalizedBranchKey}`,
        );
      }
      if (branchKeys.has(branchKey)) {
        throw new Error(`多条件节点 ${multiNode.id} 包含重复的分支 key: ${branchKey}`);
      }
      branchKeys.add(branchKey);
      return {
        key: branchKey,
        logic: branch.logic === 'or' ? 'or' : 'and',
        atoms: branch.conditions.map((entry: any, conditionIndex: number) => {
          const preparedEntry = prepareConditionEntry(entry, nodes);
          const key = normalizeMultiConditionAtomKey(
            preparedEntry,
            branchIndex,
            conditionIndex,
          );
          const id = firstAtom
            ? String(multiNode.id)
            : uniqueNodeId(
              `${multiNode.id}__ff_${branchIndex}_${conditionIndex}`,
              usedIds,
            );
          firstAtom = false;
          return {
            id,
            // The same normalized key must be present in both the generated
            // condition entry and every generated true edge below.
            key,
            entry: { ...preparedEntry, key },
            branchIndex,
            conditionIndex,
          };
        }),
      };
    });

    const baseData = { ...(multiNode.data || {}) };
    delete baseData.branch;
    const generatedNodes = descriptors.flatMap((branch: any) => branch.atoms.map((atom: any) => ({
      ...multiNode,
      id: atom.id,
      type: WorkflowNodeType.Condition,
      meta: {
        ...(multiNode.meta || {}),
        position: {
          x: Number(multiNode.meta?.position?.x || 0) + atom.conditionIndex * 24,
          y: Number(multiNode.meta?.position?.y || 0) + atom.branchIndex * 24,
        },
      },
      data: {
        ...baseData,
        title: `${baseData.title || '多条件分支'} · ${atom.branchIndex + 1}.${atom.conditionIndex + 1}`,
        conditions: [{ ...atom.entry, key: atom.key }],
      },
    })));

    const outgoing = edges.filter((edge) => edge.sourceNodeID === multiNode.id);
    const retainedEdges = edges.filter((edge) => edge.sourceNodeID !== multiNode.id);
    const elseTargets = outgoing.filter((edge) => edge.sourcePortID === 'else');
    const generatedEdges: any[] = [];

    descriptors.forEach((branch: any, branchIndex: number) => {
      const branchTargets = outgoing.filter((edge) => edge.sourcePortID === branch.key);
      const nextBranchId = descriptors[branchIndex + 1]?.atoms[0]?.id;

      branch.atoms.forEach((atom: any, conditionIndex: number) => {
        const nextAtomId = branch.atoms[conditionIndex + 1]?.id;

        if (branch.logic === 'or' || !nextAtomId) {
          generatedEdges.push(...forwardEdges(atom.id, atom.key, branchTargets));
        } else {
          generatedEdges.push(internalEdge(atom.id, atom.key, nextAtomId));
        }

        if (branch.logic === 'or' && nextAtomId) {
          generatedEdges.push(internalEdge(atom.id, 'else', nextAtomId));
        } else if (nextBranchId) {
          generatedEdges.push(internalEdge(atom.id, 'else', nextBranchId));
        } else {
          generatedEdges.push(...forwardEdges(atom.id, 'else', elseTargets));
        }
      });
    });

    nodes = nodes.flatMap((node) => (
      node.id === multiNode.id ? generatedNodes : [node]
    ));
    edges = [...retainedEdges, ...generatedEdges];
  }

  prepared.nodes = nodes;
  prepared.edges = edges;
  return prepared;
};
