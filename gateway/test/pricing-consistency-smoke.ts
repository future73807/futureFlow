import assert from 'node:assert/strict';

import { BillingService } from '../src/billing/billing.service';
import { DifyConverterService } from '../src/converter/dify-converter.service';
import { MODEL_PRICING, DEFAULT_PRICING } from '../src/billing/pricing.config';

/**
 * 定价一致性回归：**预估（冻结）与实际（结算）必须用同一套价格**。
 *
 * 背景：项目里原先有两份互不相干的定价表——
 *   - 结算：billing/pricing.config.ts 的 MODEL_PRICING（含 input/output 拆分，20 个模型）
 *   - 冻结：dify-converter.service.ts 里一个私有表（每模型单一价格，只有 8 个模型）
 *
 * 实测 20 个模型里有 19 个不一致，最高差 53 倍（gemini-1.5-flash 冻结按 0.01、
 * 结算按 0.0001875）。后果是用户被「余额不足」误拦——实际只扣很少，却要先冻结
 * 几倍甚至几十倍的钱；反向偏差（claude-3-opus 冻结仅为结算的 0.22 倍）则可能让
 * 结算金额超过冻结额。
 *
 * 本测试**直接驱动两个真实实现**（而不是各自重算一遍规则——那样测试自己就成了
 * 第三份定价逻辑），把「同一模型在两处的价格必须一致」固化成不变量。
 */

/** 冻结侧：单 LLM 节点、预估 1000 tokens 时，estimateCost 的返回值即「每 1K token 价格」。 */
function freezeCostFor1K(modelName: string): number {
  const converter = new DifyConverterService();
  return converter.estimateCost({
    nodes: [
      {
        id: 'llm_0',
        type: 'llm',
        data: { inputsValues: { modelName: { type: 'constant', content: modelName } } },
      },
    ],
  } as any);
}

/** 结算侧：同样按 1000 tokens，用真实 BillingService.calculateCost。 */
function settleCostFor1K(modelName: string): number {
  // calculateCost 是纯计算，不触碰仓储，因此用空对象作为依赖即可。
  const billing = new BillingService({} as any, {} as any, {} as any);
  return billing.calculateCost(1000, modelName, undefined);
}

/** 两者都会把总额四舍五入到 4 位小数（与 decimal(12,4) 列一致），故只需容忍浮点误差。 */
const TOLERANCE = 1e-9;

function main() {
  const models = Object.keys(MODEL_PRICING);

  // ── 1. 每个已知模型：冻结与结算在 1000 tokens 下必须给出同一金额 ──
  const mismatches: string[] = [];
  for (const model of models) {
    const freeze = freezeCostFor1K(model);
    const settle = settleCostFor1K(model);
    if (Math.abs(freeze - settle) > TOLERANCE) {
      const ratio = settle > 0 ? (freeze / settle) : Number.POSITIVE_INFINITY;
      mismatches.push(`${model}: 冻结 ${freeze} vs 结算 ${settle}（${ratio.toFixed(2)}x）`);
    }
  }
  assert.equal(
    mismatches.length,
    0,
    `预估与结算的价格必须一致，不一致的有 ${mismatches.length} 个：\n  ${mismatches.join('\n  ')}`,
  );

  // ── 2. 未知模型：两处兜底也必须一致（否则冷门模型上会被误拦）──────
  {
    const unknown = 'some-unlisted-model-xyz';
    const freeze = freezeCostFor1K(unknown);
    const settle = settleCostFor1K(unknown);
    assert.ok(
      Math.abs(freeze - settle) <= TOLERANCE,
      `未知模型 ${unknown} 的兜底价也必须一致：冻结 ${freeze} vs 结算 ${settle}`,
    );
    // 兜底价应来自 DEFAULT_PRICING，而不是硬编码的另一个值
    const expected = ((DEFAULT_PRICING.input + DEFAULT_PRICING.output) / 2);
    assert.ok(
      Math.abs(settle - expected) <= 1e-4,
      `未知模型应使用 DEFAULT_PRICING 的均价 ${expected}，实际 ${settle}`,
    );
  }

  // ── 3. 价格随 token 线性缩放（防止某天引入分段/封顶而不自知）─────
  {
    const one = freezeCostFor1K('deepseek-chat');
    const converter = new DifyConverterService();
    const tenK = converter.estimateCost({
      nodes: [
        {
          id: 'llm_0',
          type: 'llm',
          // 10 个 LLM 节点 ≈ 10 × 1000 tokens 的预估
          data: { inputsValues: { modelName: { type: 'constant', content: 'deepseek-chat' } } },
        },
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `llm_${i + 1}`,
          type: 'llm',
          data: { inputsValues: { modelName: { type: 'constant', content: 'deepseek-chat' } } },
        })),
      ],
    } as any);
    assert.ok(
      Math.abs(tenK - one * 10) <= 1e-6,
      `预估应随节点数线性增长：1 节点 ${one}，10 节点 ${tenK}`,
    );
  }

  console.log(
    `pricing consistency tests passed: ${models.length} 个模型的冻结/结算价格一致，未知模型兜底一致，预估线性`,
  );
}

main();
