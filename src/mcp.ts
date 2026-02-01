/**
 * MCP Server
 * Exposes dear-claude functionality via Model Context Protocol
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { InstanceManager } from "./core/instance-manager.js";
import type { ClaudeExecutor } from "./core/claude-executor.js";

export function createMCPServer(
  instanceManager: InstanceManager,
  executor: ClaudeExecutor
): Server {
  const server = new Server(
    {
      name: "dear-claude",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Define tools
  const tools: Tool[] = [
    {
      name: "list_platforms",
      description: "List configured platforms and their status",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    },
    {
      name: "list_instances",
      description: "List all Claude instances (active and recent)",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["all", "active", "completed", "failed"],
            description: "Filter by status",
            default: "all"
          },
          limit: {
            type: "number",
            description: "Maximum number of instances to return",
            default: 20
          }
        },
        required: []
      }
    },
    {
      name: "get_instance_status",
      description: "Get detailed status of a specific instance",
      inputSchema: {
        type: "object",
        properties: {
          instance_id: {
            type: "string",
            description: "The instance ID"
          }
        },
        required: ["instance_id"]
      }
    },
    {
      name: "get_instance_messages",
      description: "Get conversation history for an instance",
      inputSchema: {
        type: "object",
        properties: {
          instance_id: {
            type: "string",
            description: "The instance ID"
          }
        },
        required: ["instance_id"]
      }
    },
    {
      name: "kill_instance",
      description: "Terminate a running instance",
      inputSchema: {
        type: "object",
        properties: {
          instance_id: {
            type: "string",
            description: "The instance ID to kill"
          }
        },
        required: ["instance_id"]
      }
    },
    {
      name: "get_running_instances",
      description: "Get list of currently running instance IDs",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    }
  ];

  // Handle list tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "list_platforms": {
        // This would need the server config, so we return a placeholder
        // In production, this would check actual platform configurations
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                platforms: {
                  linear: true,
                  gmail: true,
                  github: true
                },
                note: "Run 'dear-claude status' for detailed platform status"
              }, null, 2)
            }
          ]
        };
      }

      case "list_instances": {
        const status = (args?.status as string) || "all";
        const limit = (args?.limit as number) || 20;

        let instances = instanceManager.getAllInstances(limit);

        if (status === "active") {
          instances = instances.filter(i => ["pending", "running", "idle"].includes(i.status));
        } else if (status !== "all") {
          instances = instances.filter(i => i.status === status);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: instances.length,
                instances: instances.map(i => ({
                  id: i.id,
                  platform: i.platform,
                  thread_id: i.thread_id,
                  status: i.status,
                  original_prompt: i.original_prompt.slice(0, 100) + (i.original_prompt.length > 100 ? "..." : ""),
                  created_at: new Date(i.created_at).toISOString(),
                  updated_at: new Date(i.updated_at).toISOString()
                }))
              }, null, 2)
            }
          ]
        };
      }

      case "get_instance_status": {
        const instanceId = args?.instance_id as string;
        if (!instanceId) {
          return {
            content: [{ type: "text", text: "Error: instance_id is required" }],
            isError: true
          };
        }

        const instance = instanceManager.getInstance(instanceId);
        if (!instance) {
          return {
            content: [{ type: "text", text: `Error: Instance ${instanceId} not found` }],
            isError: true
          };
        }

        const isRunning = executor.isRunning(instanceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: instance.id,
                platform: instance.platform,
                thread_id: instance.thread_id,
                status: instance.status,
                is_currently_running: isRunning,
                working_dir: instance.working_dir,
                original_prompt: instance.original_prompt,
                completion_summary: instance.completion_summary,
                created_at: new Date(instance.created_at).toISOString(),
                updated_at: new Date(instance.updated_at).toISOString(),
                expires_at: new Date(instance.expires_at).toISOString()
              }, null, 2)
            }
          ]
        };
      }

      case "get_instance_messages": {
        const instanceId = args?.instance_id as string;
        if (!instanceId) {
          return {
            content: [{ type: "text", text: "Error: instance_id is required" }],
            isError: true
          };
        }

        const messages = instanceManager.getMessages(instanceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                instance_id: instanceId,
                message_count: messages.length,
                messages: messages.map(m => ({
                  role: m.role,
                  content: m.content.slice(0, 500) + (m.content.length > 500 ? "..." : ""),
                  created_at: new Date(m.created_at).toISOString()
                }))
              }, null, 2)
            }
          ]
        };
      }

      case "kill_instance": {
        const instanceId = args?.instance_id as string;
        if (!instanceId) {
          return {
            content: [{ type: "text", text: "Error: instance_id is required" }],
            isError: true
          };
        }

        const killed = executor.kill(instanceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                instance_id: instanceId,
                killed,
                message: killed ? "Instance terminated" : "Instance was not running"
              }, null, 2)
            }
          ]
        };
      }

      case "get_running_instances": {
        const running = executor.getRunningInstances();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: running.length,
                instance_ids: running
              }, null, 2)
            }
          ]
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  });

  return server;
}

export interface MCPServerOptions {
  instanceManager: InstanceManager;
  executor: ClaudeExecutor;
  httpPort?: number;
  enableHttp?: boolean;
  enableTunnel?: boolean;
  db?: import("./db/schema.js").DatabaseManager;
  config?: import("./server.js").ServerConfig;
}

export async function startMCPServer(
  instanceManager: InstanceManager,
  executor: ClaudeExecutor,
  options?: Partial<MCPServerOptions>
): Promise<void> {
  const server = createMCPServer(instanceManager, executor);
  const transport = new StdioServerTransport();

  // Start HTTP server for webhooks if enabled
  if (options?.enableHttp && options.db && options.config) {
    const { serve } = await import("bun");
    const { createServer } = await import("./server.js");

    const httpPort = options.httpPort || 3334;
    let publicUrl: string | undefined;

    // Start Tailscale Funnel if enabled
    if (options.enableTunnel !== false) {
      const { TransportManager } = await import("./transport/transport.js");
      const transportManager = new TransportManager({
        port: httpPort
      });

      try {
        publicUrl = await transportManager.start();
        // Update config with public URL for OAuth callbacks
        if (options.config) {
          options.config.publicUrl = publicUrl;
        }
        console.error(`[MCP] Tailscale Funnel: ${publicUrl}`);
      } catch (err) {
        console.error(`[MCP] Tailscale Funnel failed: ${err instanceof Error ? err.message : err}`);
        console.error(`[MCP] Continuing without public URL (webhooks won't work externally)`);
      }
    }

    const app = createServer(options.config, options.db, instanceManager, executor);

    serve({
      fetch: app.fetch,
      port: httpPort
    });

    console.error(`[MCP] HTTP webhook server started on port ${httpPort}`);
    if (publicUrl) {
      console.error(`[MCP] Webhook URLs (public):`);
      console.error(`   GitHub:  ${publicUrl}/webhook/github`);
      console.error(`   Linear:  ${publicUrl}/webhook/linear`);
      console.error(`   Gmail:   ${publicUrl}/webhook/gmail`);
      console.error(`[MCP] OAuth Setup:`);
      console.error(`   GitHub:  ${publicUrl}/setup/github`);
    } else {
      console.error(`[MCP] Webhook URLs (local only):`);
      console.error(`   GitHub:  http://localhost:${httpPort}/webhook/github`);
      console.error(`   Linear:  http://localhost:${httpPort}/webhook/linear`);
      console.error(`   Gmail:   http://localhost:${httpPort}/webhook/gmail`);
    }
  }

  await server.connect(transport);
  console.error("[MCP] Server started on stdio");
}
