import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import styled from "styled-components";

const ErrorDiv = styled.div`
    width: 100%;
    display: flex;
    justify-content: center;
    flex-direction: column;
    align-items: center;
    height: 100vh;
    color: #eee;
`;

export default function ErrorPage() {
  const error = useRouteError();
  console.error(error);
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unknown error";

  return (
    <ErrorDiv id="error-page">
      <h1>Oops!</h1>
      <p>Sorry, an unexpected error has occurred.</p>
      <p>
        <i>{message}</i>
      </p>
    </ErrorDiv>
  );
}
