/**
 * 分支端口在折叠卡片上的样式。
 *
 * 端口圆点由 FlowGram 的 WorkflowPortRender 画在标记元素的位置上，所以这里只需要
 * 给出标记元素的位置：贴着卡片右边缘，按分支顺序纵向排列。
 *
 * 注意：节点卡片是 `display:flex; flex-direction:column; align-items:flex-start`，
 * 子元素默认按内容宽度收缩，所以这里必须 `align-self: stretch`，否则行宽等于标签宽度，
 * 圆点会落在标签旁边而不是卡片右边。
 */

import styled from 'styled-components';

export const CardPortList = styled.div`
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 0 8px;
`;

export const CardPortRow = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  /* 给右边缘的圆点留位置，标签不要压住它 */
  padding-right: 14px;
  height: 18px;
`;

export const CardPortLabel = styled.span`
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 0 8px;
  height: 18px;
  line-height: 18px;
  border-radius: 9px;
  font-size: 11px;
  color: var(--semi-color-text-2);
  background: var(--semi-color-fill-0);
`;

/** 端口标记：0×0 定位点，圆点由 FlowGram 以它为中心绘制，正好压在卡片右边缘上 */
export const CardPortDot = styled.div`
  position: absolute;
  right: 0;
  top: 50%;
  width: 0;
  height: 0;
`;
