# upstream_unauthorized

**HTTP 502**

## What happened

The model provider refused the framework's credential: a 401 or 403 from the provider, or a missing
API key that the AI SDK reported before any call went out (`AI_LoadAPIKeyError`). When the provider
gave a status, it rides along as `upstreamStatus`.

`upstream_unauthorized` is about the OPERATOR's key. It says nothing about the caller's own
credential — a request that failed this way had already passed the deployment's auth gate.

## Why

**502 and not 401, deliberately.** A 401 means "your credentials are wrong, fix them and retry". The
credentials that are wrong here belong to the deployment, and the caller has never seen them, cannot
read them and cannot change them. Answering 401 would send a client into a re-authentication loop
against a wall — and on a browser-facing route it would very likely log a real user out over a
provider key the user has nothing to do with.

502 is the honest answer: a dependency this server relies on did not accept it.

## What to do

**Check the provider key on the server, not the client.** Missing environment variable, expired key,
a key rotated in the dashboard but not in the deployment, or a key without access to the model this
agent names.

```bash
gnl doctor     # protections + configuration, including which model each agent resolves to
```

**A model-scoped 403 looks identical from here.** Some providers answer 403 for "your key is valid
but not entitled to this model" — if the key works elsewhere, check the model id in the agent's
config before assuming the key is dead.

**Re-drive the same runId once the key is fixed.** Nothing was committed, and the journal replays
what already completed.
