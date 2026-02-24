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
    if (sig !== expectedSig) return { ok: false as const, error: "token_signature_invalid" };

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

export class NodeTrustManager {
  private bootstrapSecret: string;
  private trusted = new Set<string>();
  private revoked = new Set<string>();

  constructor(secret?: string) {
    this.bootstrapSecret = secret ?? process.env.EDGEMESH_BOOTSTRAP_SECRET ?? "bootstrap-dev";
  }

  trustNode(nodeId: string, bootstrapToken?: string) {
    if (bootstrapToken !== this.bootstrapSecret) return false;
    if (this.revoked.has(nodeId)) return false;
    this.trusted.add(nodeId);
    return true;
  }

  revokeNode(nodeId: string) {
    this.revoked.add(nodeId);
    this.trusted.delete(nodeId);
  }

  isTrusted(nodeId: string) {
    return this.trusted.has(nodeId) && !this.revoked.has(nodeId);
  }

  isRevoked(nodeId: string) {
    return this.revoked.has(nodeId);
  }
}
