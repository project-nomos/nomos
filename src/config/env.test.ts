import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvConfig, validateConfig, type NomosConfig } from "./env.ts";

describe("loadEnvConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.DATABASE_URL;
    delete process.env.NOMOS_MODEL;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.VERTEX_AI_LOCATION;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.NOMOS_PERMISSION_MODE;
    delete process.env.NOMOS_BETAS;
    delete process.env.NOMOS_FALLBACK_MODELS;
    delete process.env.HEARTBEAT_INTERVAL_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reads env vars correctly", () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.VERTEX_AI_LOCATION = "us-central1";
    process.env.NOMOS_MODEL = "claude-opus-4-20250514";
    process.env.EMBEDDING_MODEL = "text-embedding-005";
    process.env.NOMOS_PERMISSION_MODE = "default";

    const config = loadEnvConfig();

    expect(config.databaseUrl).toBe("postgres://localhost/test");
    expect(config.googleCloudProject).toBe("my-project");
    expect(config.vertexAiLocation).toBe("us-central1");
    expect(config.model).toBe("claude-opus-4-20250514");
    expect(config.embeddingModel).toBe("text-embedding-005");
    expect(config.permissionMode).toBe("default");
  });

  it("applies defaults when env vars are not set", () => {
    const config = loadEnvConfig();

    expect(config.googleCloudProject).toBeUndefined();
    expect(config.vertexAiLocation).toBe("global");
    expect(config.databaseUrl).toBeUndefined();
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.embeddingModel).toBe("gemini-embedding-001");
    expect(config.permissionMode).toBe("acceptEdits");
    expect(config.betas).toBeUndefined();
    expect(config.fallbackModels).toBeUndefined();
    expect(config.heartbeatIntervalMs).toBe(1800000);
    expect(config.adaptiveMemory).toBe(true);
    expect(config.extractionModel).toBeUndefined();
  });

  it("parses NOMOS_BETAS comma-separated string into array", () => {
    process.env.NOMOS_BETAS = "1m-context,another-beta";

    const config = loadEnvConfig();

    expect(config.betas).toEqual(["1m-context", "another-beta"]);
  });

  it("parses NOMOS_FALLBACK_MODELS comma-separated string into array", () => {
    process.env.NOMOS_FALLBACK_MODELS = "claude-sonnet-4-6,claude-haiku-4-5-20251001";

    const config = loadEnvConfig();

    expect(config.fallbackModels).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  });

  it("trims whitespace in betas and fallback models", () => {
    process.env.NOMOS_BETAS = " beta1 , beta2 , beta3 ";
    process.env.NOMOS_FALLBACK_MODELS = " model1 , model2 ";

    const config = loadEnvConfig();

    expect(config.betas).toEqual(["beta1", "beta2", "beta3"]);
    expect(config.fallbackModels).toEqual(["model1", "model2"]);
  });

  it("filters out empty strings from betas and fallback models", () => {
    process.env.NOMOS_BETAS = "beta1,,beta2";
    process.env.NOMOS_FALLBACK_MODELS = "model1,,,model2";

    const config = loadEnvConfig();

    expect(config.betas).toEqual(["beta1", "beta2"]);
    expect(config.fallbackModels).toEqual(["model1", "model2"]);
  });
});

describe("validateConfig", () => {
  it("returns errors when no DATABASE_URL", () => {
    const config: NomosConfig = {
      model: "claude-sonnet-4-6",
      vertexAiLocation: "global",
      embeddingModel: "gemini-embedding-001",
      permissionMode: "acceptEdits",
      heartbeatIntervalMs: 1800000,
      pairingTtlMinutes: 60,
      defaultDmPolicy: "open",
      sessionScope: "channel",
      toolApprovalPolicy: "block_critical",
      apiProvider: "anthropic",
      smartRouting: false,
      modelTiers: {
        simple: "claude-haiku-4-5",
        moderate: "claude-sonnet-4-6",
        complex: "claude-sonnet-4-6",
      },
      teamMode: false,
      maxTeamWorkers: 3,
      workerBudgetUsd: 2,
      adaptiveMemory: false,
      shadowMode: false,
      alternateBuffer: false,
      imageGeneration: false,
      videoGeneration: false,
    };

    const errors = validateConfig(config);
    expect(errors).toContain(
      "DATABASE_URL is required. Set it to your PostgreSQL connection string.",
    );
  });

  it("passes when DATABASE_URL is set", () => {
    const config: NomosConfig = {
      databaseUrl: "postgres://localhost/test",
      model: "claude-sonnet-4-6",
      vertexAiLocation: "global",
      embeddingModel: "gemini-embedding-001",
      permissionMode: "acceptEdits",
      heartbeatIntervalMs: 1800000,
      pairingTtlMinutes: 60,
      defaultDmPolicy: "open",
      sessionScope: "channel",
      toolApprovalPolicy: "block_critical",
      apiProvider: "anthropic",
      smartRouting: false,
      modelTiers: {
        simple: "claude-haiku-4-5",
        moderate: "claude-sonnet-4-6",
        complex: "claude-sonnet-4-6",
      },
      teamMode: false,
      maxTeamWorkers: 3,
      workerBudgetUsd: 2,
      adaptiveMemory: false,
      shadowMode: false,
      alternateBuffer: false,
      imageGeneration: false,
      videoGeneration: false,
    };

    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });
});
