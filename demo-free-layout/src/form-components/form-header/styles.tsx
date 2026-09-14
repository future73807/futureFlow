import styled from 'styled-components';

export const Header = styled.div`
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  padding: 9px 10px 6px;
  overflow: hidden;
  border-radius: 10px 10px 0 0;
  background: #ffffff;
  box-sizing: border-box;
  cursor: move;
  user-select: none;
`;

export const Title = styled.div`
  width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ff-text);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const Icon = styled.img`
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 5px;
  object-fit: cover;
`;

export const Operators = styled.div`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
`;
