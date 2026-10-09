/**
 * [fork Evolux] Hunter — pesquisa de prospect.
 *
 * GET  ?campaign_id=  → as análises da organização (da campanha, se informada).
 * POST { action: "analyze", campaign_id, candidate_ids?, force? } → enfileira.
 *
 * O POST só ENFILEIRA: quem analisa é o job (`tickHunter`, no cron da
 * prospecção). Nada aqui envia mensagem, busca na Apify ou mexe em funil.
 * Rota separada de `../route.ts` de propósito: o fork não toca a rota oficial.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { enfileirarPesquisas } from "@/lib/prospecting/hunter/worker";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

const analyzeSchema = z
  .object({
    action: z.literal("analyze"),
    campaign_id: z.string().uuid(),
    candidate_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:read",
  });
  if (!auth.ok) return auth.response;
  const campanha = req.nextUrl.searchParams.get("campaign_id");
  if (campanha && !z.string().uuid().safeParse(campanha).success)
    return fail("validation_failed", "campaign_id inválido.", 422, { requestId, headers });
  try {
    const { rows } = await getRequestPool().query(
      `select id, campaign_id, candidate_id, status, provenance, correlation_id, icp_score, icp_tier,
              confidence, result, error, attempts, prompt_version, model, completed_at, updated_at
         from prospecting_research
        where organization_id = $1 and ($2::uuid is null or campaign_id = $2)
        order by icp_score desc nulls last, updated_at desc
        limit 5000`,
      [auth.organizationId, campanha],
    );
    return ok({ research: rows }, { requestId, headers });
  } catch {
    return fail("prospecting_unavailable", "Não foi possível carregar as análises.", 500, {
      requestId,
      headers,
    });
  }
}

export async function POST(req: NextRequest) {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:write",
  });
  if (!auth.ok) return auth.response;
  const teto = await tetoDeEscritaDoToken(auth, "prospecting", requestId);
  if (teto) return teto;
  const parsed = analyzeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Informe a campanha e, se quiser, as empresas.", 422, {
      requestId,
      headers,
    });
  const body = parsed.data;
  const org = auth.organizationId;
  try {
    const pool = getRequestPool();
    const campanha = await pool.query(
      "select id from prospecting_campaigns where organization_id=$1 and id=$2",
      [org, body.campaign_id],
    );
    if (!campanha.rows.length)
      return fail("not_found", "Campanha não encontrada.", 404, { requestId, headers });
    const actorUserId = auth.actor.type === "user" ? auth.actor.id : null;
    const resultado = await enfileirarPesquisas(pool, org, body.campaign_id, {
      candidateIds: body.candidate_ids,
      forcar: body.force,
      solicitadoPor: actorUserId,
    });
    await audit({
      action: "prospecting.research_requested",
      organizationId: org,
      actorUserId,
      actorApiTokenId: auth.apiTokenId ?? null,
      resourceType: "prospecting_campaign",
      resourceId: body.campaign_id,
      metadata: {
        agent: "hunter",
        candidates: body.candidate_ids?.length ?? "all",
        force: !!body.force,
        enqueued: resultado.enfileiradas,
      },
      requestId,
    });
    return ok(resultado, { requestId, headers });
  } catch {
    return fail("prospecting_unavailable", "Não foi possível enfileirar a análise.", 500, {
      requestId,
      headers,
    });
  }
}
