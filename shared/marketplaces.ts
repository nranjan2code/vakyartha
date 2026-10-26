export type MarketplaceId = "mcp" | "github" | "docker";
export interface MarketplaceSource { id: MarketplaceId; name: string; description: string; homepage: string }
export const MARKETPLACES: MarketplaceSource[] = [
  { id: "mcp", name: "MCP Registry", description: "The protocol's public server directory.", homepage: "https://registry.modelcontextprotocol.io" },
  { id: "github", name: "GitHub", description: "Servers from partners and the community.", homepage: "https://github.com/mcp" },
  { id: "docker", name: "Docker", description: "Container tools and hosted connections.", homepage: "https://hub.docker.com/mcp" },
];
export interface MarketplaceListing {
  key: string; source: MarketplaceId; name: string; title: string; description: string; version: string;
  homepage: string; repository: string; publisher: string; publishedAt?: string; iconUrl?: string;
  options: MarketplaceOption[];
}
export interface MarketplaceOption {
  key: string; label: string; kind: "http" | "npm" | "unsupported";
  url?: string; package?: string; version?: string;
  fields: { key: string; label: string; required?: boolean; help?: string; env?: string; header?: { name: string; format: string } }[];
  blocked?: string;
}
export interface MarketplacePage {
  source: MarketplaceId; items: MarketplaceListing[]; nextCursor?: string; fetchedAt: string; stale: boolean; warning?: string;
}
export interface MarketplaceReview {
  listing: MarketplaceListing; option: MarketplaceOption; existingId?: string;
  bin?: string; publishedAt?: string; dependencies?: Record<string, string>; scripts?: string[]; blocked?: string;
  fingerprint: string;
}
