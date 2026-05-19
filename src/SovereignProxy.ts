import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * SovereignProxy: The security-hardened gateway for the VantagePoint Mesh.
 * Implements MCP for LLM interaction and PII scrubbing for safety.
 */

// PII Scrubbing Rules - Loaded from environment to prevent repo leakage
const FORBIDDEN_PATTERNS = [
  process.env.VPC_PII_NAME_PATTERN ? new RegExp(process.env.VPC_PII_NAME_PATTERN, 'gi') : null,
  process.env.VPC_PII_EMAIL_PATTERN ? new RegExp(process.env.VPC_PII_EMAIL_PATTERN, 'gi') : null,
  process.env.VPC_PII_MAC_PATTERN ? new RegExp(process.env.VPC_PII_MAC_PATTERN, 'gi') : null,
  process.env.VPC_PII_TELEGRAM_PATTERN ? new RegExp(process.env.VPC_PII_TELEGRAM_PATTERN, 'g') : null,
  process.env.VPC_PII_PATH_PATTERN ? new RegExp(process.env.VPC_PII_PATH_PATTERN, 'gi') : null,
].filter(Boolean) as RegExp[];

/**
 * Scrubs PII and sensitive paths from strings before they reach the LLM.
 */
export function sanitizeOutput(text: string): string {
  let sanitized = text;
  FORBIDDEN_PATTERNS.forEach((pattern) => {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  });
  return sanitized;
}

const server = new Server(
  {
    name: "vantagepoint-sovereign-proxy",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Zod Schema for Mesh Data Requests.
 */
const RequestMeshDataSchema = z.object({
  query: z.string().describe("The semantic query for mesh data"),
  depth: z.number().optional().default(1).describe("Search depth in the mesh (1-5)"),
  includeMetadata: z.boolean().optional().default(false).describe("Whether to include node metadata"),
});

// Register Available Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "request_mesh_data",
        description: "Request secure data from the Sovereign Agentic Mesh",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            depth: { type: "number", minimum: 1, maximum: 5 },
            includeMetadata: { type: "boolean" },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "request_mesh_data") {
    try {
      const args = RequestMeshDataSchema.parse(request.params.arguments);
      
      // LOGIC: In production, this would communicate with MeshOrchestrator.ts
      // For this architecture, we provide a secure, sanitized mock response.
      const mockMeshData = {
        status: "success",
        origin: "MeshOrchestrator",
        results: [
          {
            id: "node-882",
            data: `Retrieved mesh data for query: ${args.query}`,
            path: "$VPC_ROOT/secure/store",
            owner: "$VPC_OWNER"
          }
        ]
      };

      const rawText = JSON.stringify(mockMeshData, null, 2);
      const sanitizedText = sanitizeOutput(rawText);
      
      return {
        content: [{ type: "text", text: sanitizedText }],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid arguments: ${error.issues.map((e: { message: string }) => e.message).join(", ")}`);
      }
      throw error;
    }
  }
  
  throw new Error(`Tool not found: ${request.params.name}`);
});

/**
 * Entry point for the MCP Server.
 */
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sovereign Proxy MCP Server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
