/**
 * 退出节点：执行到它就提前结束本次运行。
 *
 * 两种退出范围：
 *   - 退出整个工作流：终止当前这条链路（云端转换成 Dify 的 end 节点，运行在该点结束并返回
 *     这里声明的输出）；
 *   - 跳出当前循环：只能放在循环体内，执行到时立即结束当前循环（剩余轮次不再执行）。
 *
 * 节点只有输入端口（没有输出端口），保证它后面接不了东西，语义就是「到此为止」。
 */

import { FlowNodeRegistry } from '../../typings';
import { pluginIconUrl } from '../../components/plugin-icons';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';
import { WorkflowNodeType } from '../constants';

export const ExitNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Exit,
  info: {
    icon: pluginIconUrl('exit'),
    description: '执行到这里立即结束运行：结束整个工作流，或在循环体里提前跳出循环。',
  },
  meta: {
    defaultPorts: [{ type: 'input' }],
    size: {
      width: 360,
      height: 168,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('exit'),
      type: WorkflowNodeType.Exit,
      data: {
        title: '退出节点',
        // 默认结束整个工作流；放进循环体时用户切换成「跳出当前循环」
        scope: 'workflow',
        inputsValues: {},
      },
    };
  },
};
