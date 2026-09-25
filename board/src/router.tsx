import { QueryCache, MutationCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { SignedOutError } from "./lib/api";

export const getRouter = () => {
  /**
   * A session can end at any point — it lasts 30 days, and a deployment can
   * revoke one sooner. When it does, every call starts failing with a 401, and
   * a board that only checked at startup would sit there showing errors.
   *
   * Handling it in the caches rather than at each call site means one place
   * decides: drop the cached identity, and the gate in `RequireSignIn` renders
   * the sign-in screen on the next paint.
   */
  const signedOut = (error: unknown) => {
    if (error instanceof SignedOutError) {
      queryClient.setQueryData(["me"], null);
    }
  };

  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: signedOut }),
    mutationCache: new MutationCache({ onError: signedOut }),
    defaultOptions: {
      queries: {
        // A 401 is an answer, not a blip. Retrying it delays the sign-in
        // screen by three round trips and changes nothing.
        retry: (count, error) => !(error instanceof SignedOutError) && count < 2,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
