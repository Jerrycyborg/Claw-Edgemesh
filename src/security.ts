import crypto from "node:crypto";

export type JobTokenPayload = {
  jobId: string;
  targetNodeId?: string;
  requiredTags?: string[];
  exp: number;
  jti: string;
};

function b64(data: string) {
  return Buffer.from(data, "utf8").toString("base64url");
}

function fromB64(data: string) {
  return Buffer.from(data, "base64url").toString("utf8");
}

export class JobTokenManager {
  private secret: string;
  private usedJtiExp = new Map<string, number>();

  constructor(secret?: string) {
    this.secret = secret ?? process.env.EDGEMESH_JOB_TOKEN_SECRET ?? "dev-secret";
  }

  issue(input: Omit<JobTokenPayload, "jti">) {
    const payload: JobTokenPayload = { ...input, jti: crypto.randomUUID() };
    const encoded = b64(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${sig}`;
  }

  verify(
    token: string,
    expected: { jobId: string; targetNodeId?: string; requiredTags?: string[] }
  ) {
    const [encoded, sig] = token.split(".");
    if (!encoded || !sig) return { ok: false as const, error: "token_format_invalid" };

    const expectedSig = crypto
      .createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: false as const, error: "token_signature_invalid" };
    }

    let payload: JobTokenPayload;
    try {
      payload = JSON.parse(fromB64(encoded));
    } catch {
      return { ok: false as const, error: "token_payload_invalid" };
    }

    this.pruneReplayCache();

    if (Date.now() > payload.exp) return { ok: false as const, error: "token_expired" };
    if (this.usedJtiExp.has(payload.jti)) return { ok: false as const, error: "token_replay" };
    if (payload.jobId !== expected.jobId)
      return { ok: false as const, error: "token_job_mismatch" };
    if (
      expected.targetNodeId &&
      payload.targetNodeId &&
      payload.targetNodeId !== expected.targetNodeId
    ) {
      return { ok: false as const, error: "token_node_mismatch" };
    }

    this.usedJtiExp.set(payload.jti, payload.exp);
    return { ok: true as const, payload };
  }

  replayCacheSize() {
    this.pruneReplayCache();
    return this.usedJtiExp.size;
  }

  private pruneReplayCache(now = Date.now()) {
    for (const [jti, exp] of this.usedJtiExp.entries()) {
      if (exp <= now) this.usedJtiExp.delete(jti);
    }
  }
}

export class NodeJwtManager {
  private readonly secret: string;
  private readonly ttlMs: number;

  constructor(secret?: string, ttlMs?: number) {
    this.secret = secret ?? process.env.EDGEMESH_NODE_JWT_SECRET ?? "node-jwt-dev";
    this.ttlMs = ttlMs ?? 24 * 60 * 60 * 1000; // 24 h default
  }

  issue(nodeId: string): { token: string; exp: number } {
    const iat = Math.floor(Date.now() / 1000);
    const exp = Math.floor((Date.now() + this.ttlMs) / 1000);
    const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64(JSON.stringify({ sub: nodeId, iat, exp }));
    const message = `${header}.${payload}`;
    const sig = crypto.createHmac("sha256", this.secret).update(message).digest("base64url");
    return { token: `${message}.${sig}`, exp: exp * 1000 };
  }

  verify(token: string): { ok: true; nodeId: string } | { ok: false; error: string } {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, error: "token_malformed" };
    const [header, payload, sig] = parts;

    const message = `${header}.${payload}`;
    const expectedSig = crypto
      .createHmac("sha256", this.secret)
      .update(message)
      .digest("base64url");
    const sigBuf = Buffer.from(sig, "base64url");
    const expectedBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: false, error: "token_signature_invalid" };
    }

    let claims: { sub?: string; exp?: number };
    try {
      claims = JSON.parse(fromB64(payload));
    } catch {
      return { ok: false, error: "token_payload_invalid" };
    }

    if (!claims.sub) return { ok: false, error: "token_missing_subject" };
    if (!claims.exp || Math.floor(Date.now() / 1000) > claims.exp) {
      return { ok: false, error: "token_expired" };
    }

    return { ok: true, nodeId: claims.sub };
  }
}

export class NodeTrustManager {
  private bootstrapSecret: string;

  constructor(secret?: string) {
    this.bootstrapSecret = secret ?? process.env.EDGEMESH_BOOTSTRAP_SECRET ?? "bootstrap-dev";
  }

  verifyBootstrapToken(token?: string): boolean {
    return typeof token === "string" && token === this.bootstrapSecret;
  }
}
