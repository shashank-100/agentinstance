# Gmail connection

The Connectors tab can connect Gmail for searching and reading conversations. The
OAuth grant is `gmail.readonly`; no sending, deleting, or mailbox modification
is implemented. Email content is treated as untrusted input by the tools.

Create a Google Cloud project, enable the Gmail API, configure the OAuth consent
screen, and create an OAuth client of type **Web application**. In testing mode,
add the Gmail accounts that will connect as test users. Set this exact authorized
redirect URI for the current deployment:

https://agentinstance.shashank-telkhade.workers.dev/gmail/callback

Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the API Worker using
`npx wrangler secret put GOOGLE_CLIENT_ID` and
`npx wrangler secret put GOOGLE_CLIENT_SECRET`. Enter values in the CLI prompt;
keep them out of source control and chat. A self-hosted deployment uses its own
API origin followed by `/gmail/callback`.

Open the Connectors tab and choose **Connect Gmail**. A signed-in user's connection
belongs to that account. A signed-out user receives a private namespace derived
from the verified Gmail address. Existing deployment tasks stay in their original
namespace. OAuth state is signed, expires in ten minutes, and binds the initiating
account to the callback. Refresh tokens stay in that account's registry and are
never included in tool responses or sent into the agent VM.

Start a task without a repository, for example:

> Find inbox conversations about our open Product Designer role. Summarize each
> candidate's relevant experience, link to the conversation, and flag questions.

`gmail_search` accepts Gmail search syntax and returns up to ten thread IDs.
`gmail_read` returns the last twenty messages, each limited to 12,000 characters,
with sender, recipient, subject, date, and a Gmail link. Attachments are not
parsed. Disconnect removes the stored refresh token and attempts Google token
revocation; running agents then lose Gmail access.

Google may require verification for production use of restricted Gmail scopes.
Testing-mode grants may expire; reconnect when the dashboard asks.

References: [Google OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
