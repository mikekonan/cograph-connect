import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { normalizeMcpUrl } from "./config.js";
import { PACKAGE_VERSION } from "./version.js";

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
    { name: "cograph-connect", version: PACKAGE_VERSION },
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
