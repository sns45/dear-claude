/**
 * CLI Commands
 * Command-line interface for dear-claude
 */

import { Command } from "commander";
import { serve } from "bun";
import { DatabaseManager } from "./db/schema.js";
import { InstanceManager } from "./core/instance-manager.js";
import { ClaudeExecutor } from "./core/claude-executor.js";
import { TransportManager } from "./transport/transport.js";
import { createServer, type ServerConfig } from "./server.js";
import { startMCPServer } from "./mcp.js";

function getConfig(): ServerConfig {
  return {
    port: parseInt(process.env.DEAR_CLAUDE_PORT || "3334", 10),
    linear: {
      clientId: process.env.LINEAR_CLIENT_ID,
      clientSecret: process.env.LINEAR_CLIENT_SECRET,
      webhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
      accessToken: process.env.LINEAR_ACCESS_TOKEN
    },
    gmail: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      accessToken: process.env.GOOGLE_ACCESS_TOKEN,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      pubsubTopic: process.env.GOOGLE_PUBSUB_TOPIC
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      accessToken: process.env.GITHUB_ACCESS_TOKEN
    }
  };
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name("dear-claude")
    .description("Trigger local Claude Code instances from external platforms")
    .version("1.0.0");

  // Start command
  program
    .command("start")
    .description("Start the dear-claude server")
    .option("-p, --port <port>", "Port to listen on", "3334")
    .option("--no-tunnel", "Disable Tailscale Funnel")
    .option("--mcp", "Run as MCP server (stdio mode)")
    .action(async (options) => {
      const config = getConfig();
      config.port = parseInt(options.port, 10);

      // Initialize components
      const db = new DatabaseManager();
      const instanceManager = new InstanceManager(db);
      const executor = new ClaudeExecutor(instanceManager);

      // Cleanup expired instances periodically
      setInterval(() => instanceManager.cleanupExpired(), 60 * 60 * 1000);

      if (options.mcp) {
        // Run as MCP server with HTTP webhook support
        await startMCPServer(instanceManager, executor, {
          instanceManager,
          executor,
          enableHttp: true,
          httpPort: config.port,
          enableTunnel: options.tunnel !== false,
          db,
          config
        });
        return;
      }

      // Start transport (Tailscale Funnel)
      let transport: TransportManager | undefined;
      if (options.tunnel !== false) {
        transport = new TransportManager({
          port: config.port
        });

        try {
          config.publicUrl = await transport.start();
          console.log(`\n🌐 Public URL: ${config.publicUrl}`);
        } catch (err) {
          console.error("Failed to start Tailscale Funnel:", err);
          console.log("Running without tunnel (webhooks will not work externally)");
        }
      }

      // Create Hono app
      const app = createServer(config, db, instanceManager, executor);

      // Start server
      const server = serve({
        fetch: app.fetch,
        port: config.port
      });

      console.log(`\n🚀 dear-claude server running on port ${config.port}`);

      if (config.publicUrl) {
        console.log(`\n📍 Webhook URLs:`);
        console.log(`   Linear:  ${config.publicUrl}/webhook/linear`);
        console.log(`   Gmail:   ${config.publicUrl}/webhook/gmail`);
        console.log(`   GitHub:  ${config.publicUrl}/webhook/github`);
        console.log(`\n🔐 OAuth Setup:`);
        console.log(`   Linear:  ${config.publicUrl}/setup/linear`);
        console.log(`   Gmail:   ${config.publicUrl}/setup/gmail`);
        console.log(`   GitHub:  ${config.publicUrl}/setup/github`);
      }

      console.log(`\n✅ Health check: http://localhost:${config.port}/health`);

      // Handle shutdown
      const shutdown = async () => {
        console.log("\n\nShutting down...");
        await executor.cleanup();
        if (transport) await transport.stop();
        db.close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  // Status command
  program
    .command("status")
    .description("Check server and platform status")
    .action(async () => {
      const config = getConfig();

      console.log("\n📊 dear-claude Status\n");

      // Check platforms
      console.log("Platforms:");
      console.log(`  Linear:  ${config.linear?.accessToken ? "✅ Connected" : config.linear?.clientId ? "⚠️  OAuth configured" : "❌ Not configured"}`);
      console.log(`  Gmail:   ${config.gmail?.accessToken ? "✅ Connected" : config.gmail?.clientId ? "⚠️  OAuth configured" : "❌ Not configured"}`);
      console.log(`  GitHub:  ${config.github?.accessToken ? "✅ Connected" : config.github?.clientId ? "⚠️  OAuth configured" : "❌ Not configured"}`);

      // Check database
      try {
        const db = new DatabaseManager();
        const instanceManager = new InstanceManager(db);
        const instances = instanceManager.getAllInstances(100);
        const active = instances.filter(i => ["pending", "running", "idle"].includes(i.status));

        console.log(`\nInstances:`);
        console.log(`  Total:   ${instances.length}`);
        console.log(`  Active:  ${active.length}`);

        if (active.length > 0) {
          console.log(`\nActive instances:`);
          for (const instance of active.slice(0, 5)) {
            console.log(`  • ${instance.id.slice(0, 8)} [${instance.platform}] ${instance.status} - "${instance.original_prompt.slice(0, 40)}..."`);
          }
        }

        db.close();
      } catch (err) {
        console.log(`\nDatabase: ❌ Error - ${err}`);
      }
    });

  // Instances command
  program
    .command("instances")
    .description("List instances")
    .option("-s, --status <status>", "Filter by status (pending, running, completed, failed, idle)")
    .option("-n, --limit <n>", "Limit number of results", "20")
    .action(async (options) => {
      const db = new DatabaseManager();
      const instanceManager = new InstanceManager(db);

      let instances = instanceManager.getAllInstances(parseInt(options.limit, 10));

      if (options.status) {
        instances = instances.filter(i => i.status === options.status);
      }

      console.log(`\n📋 Instances (${instances.length})\n`);

      if (instances.length === 0) {
        console.log("No instances found.");
      } else {
        for (const instance of instances) {
          const date = new Date(instance.updated_at).toLocaleString();
          console.log(`${instance.id.slice(0, 8)}  [${instance.platform.padEnd(6)}]  ${instance.status.padEnd(9)}  ${date}`);
          console.log(`          "${instance.original_prompt.slice(0, 60)}${instance.original_prompt.length > 60 ? "..." : ""}"`);
          console.log();
        }
      }

      db.close();
    });

  // Logs command
  program
    .command("logs <instance-id>")
    .description("View instance conversation logs")
    .action(async (instanceId) => {
      const db = new DatabaseManager();
      const instanceManager = new InstanceManager(db);

      // Try to find by full ID or prefix
      let instance = instanceManager.getInstance(instanceId);

      if (!instance) {
        // Try prefix match
        const all = instanceManager.getAllInstances(1000);
        instance = all.find(i => i.id.startsWith(instanceId));
      }

      if (!instance) {
        console.error(`Instance not found: ${instanceId}`);
        process.exit(1);
      }

      const messages = instanceManager.getMessages(instance.id);

      console.log(`\n📝 Logs for ${instance.id}\n`);
      console.log(`Platform: ${instance.platform}`);
      console.log(`Status:   ${instance.status}`);
      console.log(`Created:  ${new Date(instance.created_at).toLocaleString()}`);
      console.log(`Updated:  ${new Date(instance.updated_at).toLocaleString()}`);
      console.log(`\n--- Messages (${messages.length}) ---\n`);

      for (const msg of messages) {
        const date = new Date(msg.created_at).toLocaleString();
        console.log(`[${msg.role.toUpperCase()}] ${date}`);
        console.log(msg.content);
        console.log();
      }

      db.close();
    });

  // Setup command
  program
    .command("setup <platform>")
    .description("Configure a platform (linear, gmail, github)")
    .action(async (platform) => {
      const validPlatforms = ["linear", "gmail", "github"];
      if (!validPlatforms.includes(platform)) {
        console.error(`Invalid platform: ${platform}`);
        console.log(`Valid platforms: ${validPlatforms.join(", ")}`);
        process.exit(1);
      }

      const config = getConfig();

      console.log(`\n🔧 Setting up ${platform}...\n`);
      console.log("This will start a temporary server for OAuth authentication.");
      console.log("Make sure you have configured the following environment variables:\n");

      if (platform === "linear") {
        console.log("  LINEAR_CLIENT_ID");
        console.log("  LINEAR_CLIENT_SECRET");
        console.log("\n(Get these from Linear Settings → API → OAuth Applications)");
      } else if (platform === "gmail") {
        console.log("  GOOGLE_CLIENT_ID");
        console.log("  GOOGLE_CLIENT_SECRET");
        console.log("\n(Get these from Google Cloud Console → APIs & Services → Credentials)");
      } else if (platform === "github") {
        console.log("  GITHUB_CLIENT_ID");
        console.log("  GITHUB_CLIENT_SECRET");
        console.log("\n(Get these from GitHub Settings → Developer settings → OAuth Apps)");
      }

      console.log("\nOnce configured, run 'dear-claude start' and visit:");
      console.log(`  http://localhost:${config.port}/setup/${platform}`);
      console.log("\nOr use the Tailscale Funnel URL if running with a tunnel.");
    });

  return program;
}
