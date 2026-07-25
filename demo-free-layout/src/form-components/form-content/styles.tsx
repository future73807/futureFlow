import styled from 'styled-components';

export const FormWrapper = styled.div`
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 12px;
  border-radius: 0 0 var(--ff-radius) var(--ff-radius);
  background: #ffffff;
  box-sizing: border-box;
`;

export const FormTitleDescription = styled.div`
  padding: 0 4px;
  color: var(--ff-muted);
  font-size: 12px;
  line-height: 20px;
  word-break: break-word;
  white-space: break-spaces;
`;
