import { Component, ReactNode } from 'react';
import { FlowNodeEntity, useNodeRender } from '@flowgram.ai/free-layout-editor';
import './sidebar-node-renderer.css';
import { NodeRenderContext } from '../../context';

interface RenderBoundaryProps {
  children: ReactNode;
}

interface RenderBoundaryState {
  failed: boolean;
}

class NodeRenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  state: RenderBoundaryState = { failed: false };

  static getDerivedStateFromError(): RenderBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previousProps: RenderBoundaryProps) {
    if (previousProps.children !== this.props.children && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="canvas-node-form-fallback">
          <strong>节点配置无法加载</strong>
          <span>请重新选择该节点，或检查节点字段后重试。</span>
        </div>
      );
    }

    return this.props.children;
  }
}

export function SidebarNodeRenderer({ node }: { node: FlowNodeEntity }) {
  const nodeRender = useNodeRender(node);

  return (
    <NodeRenderContext.Provider value={nodeRender}>
      <div className="canvas-node-form-surface">
        <NodeRenderBoundary>
          {nodeRender.form?.render() || (
            <div className="canvas-node-form-fallback">
              <strong>节点尚未配置</strong>
              <span>请选择节点后继续编辑。</span>
            </div>
          )}
        </NodeRenderBoundary>
      </div>
    </NodeRenderContext.Provider>
  );
}
