import styled from 'styled-components';

export const Header = styled.div`
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  overflow: hidden;
  border-bottom: 1px solid #edf0f5;
  border-radius: var(--ff-radius) var(--ff-radius) 0 0;
  background: #f8fafc;
  box-sizing: border-box;
  cursor: move;
`;

export const Title = styled.div`
  width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ff-text);
  font-size: 14px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const Icon = styled.img`
  width: 22px;
  height: 22px;
  border-radius: 5px;
  object-fit: cover;
`;

export const Operators = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;
