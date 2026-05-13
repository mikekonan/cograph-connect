import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import { requireProfile } from "./config.js";
import { closeRemote, connectRemote, type RemoteConnection } from "./remote.js";
import { PACKAGE_VERSION } from "./version.js";

function proxiedCapabilities(client: Client): ServerCapabilities {
  const remote = client.getServerCapabilities();
  const capabilities: ServerCapabilities = {};
  if (remote?.tools) capabilities.tools = {};
  if (remote?.resources) capabilities.resources = {};
  if (remote?.prompts) capabilities.prompts = {};
  return capabilities;
}

export async function runMcpProxy(profileName?: string): Promise<void> {
  const profile = await requireProfile(profileName);
  let remote: RemoteConnection | undefined;
  try {
    remote = await connectRemote(profile);
    const server = new Server(
      { name: "cograph", version: PACKAGE_VERSION },
      {
        capabilities: proxiedCapabilities(remote.client),
        instructions:
          remote.client.getInstructions() ||
          "Use Cograph to query indexed repositories, wiki pages, graph context, and markdown collections.",
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, (request) =>
      remote!.client.listTools(request.params),
    );
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      remote!.client.callTool(request.params),
    );
    server.setRequestHandler(ListResourcesRequestSchema, (request) =>
      remote!.client.listResources(request.params),
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
      remote!.client.listResourceTemplates(request.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, (request) =>
      remote!.client.readResource(request.params),
    );
    server.setRequestHandler(ListPromptsRequestSchema, (request) =>
      remote!.client.listPrompts(request.params),
    );
    server.setRequestHandler(GetPromptRequestSchema, (request) =>
      remote!.client.getPrompt(request.params),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cograph-connect MCP proxy failed: ${message}\n`);
    await (remote ? closeRemote(remote) : Promise.resolve());
    process.exitCode = 1;
  }
}
