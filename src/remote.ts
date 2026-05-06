import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { normalizeMcpUrl } from "./config.js";

export type RemoteConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

export async function connectRemote({
  url,
  token,
}: {
  url: string;
  token: string;
}): Promise<RemoteConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(normalizeMcpUrl(url)), {
    requestInit: {
      headers: new Headers({
        Authorization: `Bearer ${token}`,
      }),
    },
  });
  const client = new Client(
    { name: "cograph-connect", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

export async function closeRemote(connection: RemoteConnection): Promise<void> {
  await connection.transport.terminateSession().catch(() => undefined);
  await connection.client.close().catch(() => undefined);
}

export async function validateRemote({
  url,
  token,
}: {
  url: string;
  token: string;
}): Promise<number> {
  const connection = await connectRemote({ url, token });
  try {
    const result = await connection.client.listTools();
    return result.tools.length;
  } finally {
    await closeRemote(connection);
  }
}
