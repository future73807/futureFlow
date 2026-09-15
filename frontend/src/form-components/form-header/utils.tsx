import { useState } from 'react';
import { IconApps } from '@douyinfe/semi-icons';
import { type FlowNodeEntity } from '@flowgram.ai/free-layout-editor';
import { FlowNodeRegistry } from '../../typings';
import { Icon } from './styles';

const NodeHeaderIcon = ({ source }: { source?: string }) => {
  const [failed, setFailed] = useState(!source);

  if (failed) {
    return <span className="node-header-icon-fallback" aria-hidden="true"><IconApps /></span>;
  }

  return <Icon src={source} alt="" aria-hidden="true" onError={() => setFailed(true)} />;
};

export const getIcon = (node: FlowNodeEntity) => {
  const source = node.getNodeRegistry<FlowNodeRegistry>().info?.icon;
  return <NodeHeaderIcon source={source} />;
};
