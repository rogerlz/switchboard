const http = require("http");
const crypto = require("crypto");
const { openExternalUrl } = require("./externalUrlOpener");

const OAUTH_TIMEOUT_MS = 120000;

// Thrown by handleCallback to report a specific error code (defaults to
// "server_error").
class OAuthFlowError extends Error {
  constructor(redirectCode, message) {
    super(message);
    this.redirectCode = redirectCode;
  }
}

// The browser tab lands on a local page: nothing leaves the machine once the
// provider redirects back to the loopback server.
function redirect(res, params) {
  const failed = Object.keys(params).some((key) => key.endsWith("_error"));
  const message = failed
    ? "Calendar connection failed. You can close this tab and try again in Switchboard."
    : "Calendar connected. You can close this tab.";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Switchboard</title>` +
      `<body style="font-family:-apple-system,sans-serif;padding:48px"><h3>${message}</h3></body>`
  );
}

// Runs a PKCE auth-code flow through an ephemeral 127.0.0.1 server:
// - buildAuthUrl(redirectUri, state, codeChallenge) → provider authorize URL
// - handleCallback(code, redirectUri, codeVerifier) → resolves the flow result;
//   called once with a state-validated code, throws (OAuthFlowError for a
//   specific callback-page code) to reject.
// - errorParam — error key reported to the callback page (e.g. "gcal_error");
//   the success key is derived from the same prefix.
function runOAuthLoopbackFlow({ buildAuthUrl, handleCallback, errorParam }) {
  const connectedParam = errorParam.replace(/_error$/, "_connected");

  return new Promise((resolve, reject) => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("hex");
    let callbackClaimed = false;

    const server = http.createServer(async (req, res) => {
      // Accepted requests can outlive server.close(), so only the first
      // terminal callback may settle the flow or exchange a code.
      if (callbackClaimed) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h3>Invalid request.</h3></body></html>");
        return;
      }

      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          callbackClaimed = true;
          redirect(res, { [errorParam]: error });
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h3>Invalid request.</h3></body></html>");
          // A real callback with a code but the wrong state is a failed
          // attempt (stale tab, CSRF). Fail the flow now. A request with no
          // code (favicon / bare GET) must keep waiting for the redirect.
          if (code) {
            callbackClaimed = true;
            cleanup();
            reject(new Error("OAuth state mismatch"));
          }
          return;
        }

        callbackClaimed = true;
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const result = await handleCallback(code, redirectUri, codeVerifier);

        redirect(res, { [connectedParam]: "true" });
        cleanup();
        resolve(result);
      } catch (err) {
        callbackClaimed = true;
        redirect(res, { [errorParam]: err.redirectCode || "server_error" });
        cleanup();
        reject(err);
      }
    });

    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      server.close();
    };

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      // Fire-and-forget like the shell.openExternal call it replaced: a failed
      // browser launch surfaces as the flow timeout.
      openExternalUrl(buildAuthUrl(redirectUri, state, codeChallenge)).catch(() => {});
    });

    timeoutId = setTimeout(() => {
      callbackClaimed = true;
      server.close();
      reject(new Error("OAuth flow timed out"));
    }, OAUTH_TIMEOUT_MS);

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

module.exports = { runOAuthLoopbackFlow, OAuthFlowError };
