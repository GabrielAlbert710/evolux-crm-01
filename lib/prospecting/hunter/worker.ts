/**
 * [fork Evolux] HUNTER_ANALYZE_PROSPECT — o job durável da pesquisa de prospect.
 *
 * A fila É a tabela `prospecting_research` (uma linha por empresa encontrada,
 * `unique (organization_id, candidate_id)`): PENDING → PROCESSING →
 * COMPLETED | FAILED. Não há tabela de fila à parte nem evento novo.
 *
 * Idempotência:
 *  - enfileirar é `insert ... on conflict do nothing` — repetir não duplica;
 *    reanalisar (`forcar`) reaproveita a MESMA linha, com correlation_id novo;
 *  - reivindicar usa `for update skip locked`, então dois ticks não pegam a
 *    mesma empresa;
 *  - concluir só grava se a linha ainda estiver `processing` com o MESMO
 *    correlation_id — um retry atrasado não sobrescreve uma análise mais nova.
 *
 * O Hunter NÃO fala com ninguém: a chamada de modelo vai SEM ferramentas
 * (nenhum envio, agenda, funil ou caso ao alcance), e este módulo não importa
 * nada de mensagens, calendário ou funil — `tests/unit/evolux-hunter.test.ts`
 * reprova se alguém importar. Também não busca na Apify: lê só o que a
 * prospecção já gravou em `prospecting_candidates.data`.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { llmEdgeConfigFromEnv, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { prospectEnrichmentSchema } from "../schema";
import { HUNTER_PROMPT_VERSION, HUNTER_SYSTEM } from "./prompt";
import { hunterModelOutputSchema, type HunterResearch } from "./schema";
import { extrairJson, sanearSaida, type EntradaDoHunter } from "./saneamento";

/** O ponto de IA do Hunter — a escolha do modelo vive em IA › Provedores (`ai_purpose_bindings`). */
export const PONTO_DO_HUNTER = "prospecting_research";
export const MAX_TENTATIVAS = 3;
/** Uma análise "processing" há mais que isto é de um processo que morreu. */
const PRAZO_DE_PROCESSAMENTO = "10 minutes";

type Db = Pick<pg.Pool, "query">;

export interface LinhaDePesquisa {
  id: string;
  organization_id: string;
  campaign_id: string;
  candidate_id: string;
  correlation_id: string;
  attempts: number;
}

/**
 * Enfileira as empresas de uma campanha (todas, ou só `candidateIds`).
 * Sem `forcar`, empresa já enfileirada ou analisada fica como está.
 */
export async function enfileirarPesquisas(
  db: Db,
  org: string,
  campaignId: string,
  opcoes: { candidateIds?: string[]; forcar?: boolean; solicitadoPor?: string | null } = {},
): Promise<{ enfileiradas: number }> {
  const { rows } = await db.query<{ id: string }>(
    `insert into prospecting_research (organization_id, campaign_id, candidate_id, requested_by)
     select p.organization_id, p.campaign_id, p.id, $4
       from prospecting_candidates p
      where p.organization_id = $1 and p.campaign_id = $2
        and ($3::uuid[] is null or p.id = any($3::uuid[]))
        and p.suppression_salt is null
     on conflict (organization_id, candidate_id) do update
        set status = 'pending', attempts = 0, error = null,
            correlation_id = gen_random_uuid(), requested_by = excluded.requested_by,
            started_at = null, updated_at = now()
      where $5::boolean and prospecting_research.status in ('completed', 'failed')
     returning id`,
    [org, campaignId, opcoes.candidateIds ?? null, opcoes.solicitadoPor ?? null, !!opcoes.forcar],
  );
  return { enfileiradas: rows.length };
}

/**
 * "Prospect encontrado" → Hunter. Toda empresa de busca concluída que ainda
 * não tem pesquisa entra na fila. A organização desliga com
 * `settings.prospecting.hunter_auto = false`.
 */
export async function enfileirarEncontradas(db: Db, limite = 50): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `insert into prospecting_research (organization_id, campaign_id, candidate_id)
     select p.organization_id, p.campaign_id, p.id
       from prospecting_candidates p
       join prospecting_campaigns c on c.organization_id = p.organization_id and c.id = p.campaign_id
       join organizations o on o.id = p.organization_id
      where c.search_status = 'succeeded'
        and p.suppression_salt is null
        and coalesce(o.settings #>> '{prospecting,hunter_auto}', 'true') <> 'false'
        and public.fn_org_operante(p.organization_id)
        and not exists (select 1 from prospecting_research r
                         where r.organization_id = p.organization_id and r.candidate_id = p.id)
      order by p.created_at
      limit $1
     on conflict (organization_id, candidate_id) do nothing
     returning id`,
    [limite],
  );
  return rows.length;
}

/** Pega até `limite` análises pendentes (ou órfãs), marcando-as `processing`. */
export async function reivindicar(db: Db, limite: number, org?: string): Promise<LinhaDePesquisa[]> {
  const { rows } = await db.query<LinhaDePesquisa>(
    `update prospecting_research r
        set status = 'processing', attempts = r.attempts + 1, started_at = now(), updated_at = now()
      where r.id in (
        select id from prospecting_research
         where (status = 'pending'
                or (status = 'processing' and started_at < now() - interval '${PRAZO_DE_PROCESSAMENTO}'))
           and attempts < ${MAX_TENTATIVAS}
           and ($2::uuid is null or organization_id = $2)
           and public.fn_org_operante(organization_id)
         order by updated_at
         limit $1
         for update skip locked)
      returning r.id, r.organization_id, r.campaign_id, r.candidate_id, r.correlation_id, r.attempts`,
    [limite, org ?? null],
  );
  return rows;
}

/** Lê a empresa e a campanha, só com filtro de organização. */
export async function carregarEntrada(db: Db, linha: LinhaDePesquisa): Promise<EntradaDoHunter> {
  const { rows } = await db.query<{ data: unknown; phone: string | null; search: Record<string, unknown> | null }>(
    `select p.data, p.phone, c.search
       from prospecting_candidates p
       join prospecting_campaigns c on c.organization_id = p.organization_id and c.id = p.campaign_id
      where p.organization_id = $1 and p.id = $2 and p.campaign_id = $3`,
    [linha.organization_id, linha.candidate_id, linha.campaign_id],
  );
  const r = rows[0];
  if (!r) throw new Error("empresa não encontrada na prospecção");
  const dados = (r.data ?? {}) as Record<string, unknown>;
  const empresa = prospectEnrichmentSchema.parse({
    name: dados.name ?? "",
    category: dados.category ?? null,
    address: dados.address ?? null,
    website: dados.website ?? null,
    maps_url: dados.maps_url ?? null,
    rating: dados.rating ?? null,
    reviews: dados.reviews ?? null,
    emails: Array.isArray(dados.emails) ? dados.emails : [],
    socials: Array.isArray(dados.socials) ? dados.socials : [],
  });
  const phone = typeof dados.phone === "string" ? dados.phone : r.phone;
  const s = r.search ?? {};
  return {
    empresa: { ...empresa, phone: phone ?? null },
    campanha: {
      niche: typeof s.niche === "string" ? s.niche : null,
      location: typeof s.location === "string" ? s.location : null,
    },
  };
}

export const hashDaEntrada = (e: EntradaDoHunter) =>
  createHash("sha256").update(JSON.stringify(e)).digest("hex");

/** O seam do modelo — injetável nos testes. */
export type ChamarModelo = (args: {
  org: string;
  entrada: EntradaDoHunter;
}) => Promise<{ texto: string; callId: string | null; provider: string; model: string; costCents: number | null; usage: unknown }>;

export function chamarModeloPadrao(pool: pg.Pool): ChamarModelo {
  return async ({ org, entrada }) => {
    const { result, callId, provider, model, costCents, usage } = await runModelCall(
      pool,
      llmEdgeConfigFromEnv(env),
      {
        tenantId: org,
        purpose: "prospecting_research",
        // SEM `tools`: o Hunter não tem nenhuma ação ao alcance.
        maxSteps: 1,
        // O teto da organização (4096 por padrão) prevalece sobre este. JSON cortado
        // no meio não serve — por isso o prompt limita o tamanho das listas.
        maxOutputTokens: 4096,
        system: HUNTER_SYSTEM,
        messages: [
          {
            role: "user",
            content: `CAMPANHA: ${JSON.stringify(entrada.campanha)}\nDADOS_DA_EMPRESA: ${JSON.stringify(entrada.empresa)}`,
          },
        ],
      },
      { log: logger },
    );
    return {
      texto: result.text ?? "",
      callId,
      provider,
      model,
      costCents: typeof costCents === "number" ? costCents : null,
      usage,
    };
  };
}

export type ResultadoDaAnalise =
  | { ok: true; pesquisa: HunterResearch }
  | { ok: false; erro: string; definitivo: boolean };

/** Analisa UMA linha já reivindicada e grava o desfecho. Nunca lança. */
export async function analisarPesquisa(
  db: Db,
  linha: LinhaDePesquisa,
  chamar: ChamarModelo,
): Promise<ResultadoDaAnalise> {
  const inicio = Date.now();
  let meta: { callId: string | null; provider: string | null; model: string | null; costCents: number | null; usage: unknown } = {
    callId: null,
    provider: null,
    model: null,
    costCents: null,
    usage: null,
  };
  let inputHash: string | null = null;
  try {
    const entrada = await carregarEntrada(db, linha);
    inputHash = hashDaEntrada(entrada);
    const resposta = await chamar({ org: linha.organization_id, entrada });
    meta = resposta;
    const bruto = hunterModelOutputSchema.parse(extrairJson(resposta.texto));
    const pesquisa = sanearSaida(bruto, entrada);
    const { rowCount } = await db.query(
      `update prospecting_research
          set status = 'completed', result = $4::jsonb, icp_score = $5, icp_tier = $6, confidence = $7,
              prompt_version = $8, provider = $9, model = $10, llm_call_id = $11, input_hash = $12,
              provenance = 'prospecting_source', error = null, completed_at = now(), updated_at = now()
        where organization_id = $1 and id = $2 and correlation_id = $3 and status = 'processing'`,
      [
        linha.organization_id,
        linha.id,
        linha.correlation_id,
        JSON.stringify(pesquisa),
        pesquisa.icp_score,
        pesquisa.icp_tier,
        pesquisa.confidence,
        HUNTER_PROMPT_VERSION,
        resposta.provider,
        resposta.model,
        resposta.callId,
        inputHash,
      ],
    );
    if (rowCount)
      await audit({
        action: "prospecting.research_completed",
        organizationId: linha.organization_id,
        resourceType: "prospecting_research",
        resourceId: linha.id,
        metadata: {
          candidate_id: linha.candidate_id,
          campaign_id: linha.campaign_id,
          correlation_id: linha.correlation_id,
          agent: "hunter",
          prompt_version: HUNTER_PROMPT_VERSION,
          provider: resposta.provider,
          model: resposta.model,
          llm_call_id: resposta.callId,
          input_hash: inputHash,
          icp_score: pesquisa.icp_score,
          icp_tier: pesquisa.icp_tier,
          confidence: pesquisa.confidence,
          corrections: pesquisa.corrections.length,
          duration_ms: Date.now() - inicio,
          cost_cents: resposta.costCents,
          usage: resposta.usage,
          attempt: linha.attempts,
        },
      });
    return { ok: true, pesquisa };
  } catch (error) {
    const erro = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const definitivo = linha.attempts >= MAX_TENTATIVAS;
    // Com tentativa sobrando, volta a `pending` (o próximo tick tenta de novo, na MESMA linha).
    await db.query(
      `update prospecting_research
          set status = $4, error = $5, llm_call_id = coalesce($6, llm_call_id), model = coalesce($7, model),
              provider = coalesce($8, provider), input_hash = coalesce($9, input_hash),
              prompt_version = $10, updated_at = now()
        where organization_id = $1 and id = $2 and correlation_id = $3 and status = 'processing'`,
      [
        linha.organization_id,
        linha.id,
        linha.correlation_id,
        definitivo ? "failed" : "pending",
        erro,
        meta.callId,
        meta.model,
        meta.provider,
        inputHash,
        HUNTER_PROMPT_VERSION,
      ],
    );
    logger.warn("[hunter] análise falhou", {
      organization_id: linha.organization_id,
      research_id: linha.id,
      correlation_id: linha.correlation_id,
      attempt: linha.attempts,
      definitivo,
      error: erro,
    });
    if (definitivo)
      await audit({
        action: "prospecting.research_failed",
        organizationId: linha.organization_id,
        resourceType: "prospecting_research",
        resourceId: linha.id,
        metadata: {
          candidate_id: linha.candidate_id,
          campaign_id: linha.campaign_id,
          correlation_id: linha.correlation_id,
          agent: "hunter",
          prompt_version: HUNTER_PROMPT_VERSION,
          llm_call_id: meta.callId,
          error: erro,
          attempts: linha.attempts,
          duration_ms: Date.now() - inicio,
        },
      });
    return { ok: false, erro, definitivo };
  }
}

/**
 * Uma rodada do Hunter — chamada pelo cron da prospecção. Rodada vazia não
 * audita nada (só a análise que aconteceu audita).
 */
export async function tickHunter(
  pool: pg.Pool,
  opcoes: { limite?: number; chamar?: ChamarModelo; prazoMs?: number } = {},
): Promise<{ enfileiradas: number; analisadas: number; falhas: number }> {
  const enfileiradas = await enfileirarEncontradas(pool);
  const chamar = opcoes.chamar ?? chamarModeloPadrao(pool);
  const prazo = Date.now() + (opcoes.prazoMs ?? 120_000);
  let analisadas = 0;
  let falhas = 0;
  for (const linha of await reivindicar(pool, opcoes.limite ?? 3)) {
    if (Date.now() >= prazo) {
      // Devolve sem gastar a tentativa: o próximo tick pega.
      await pool.query(
        "update prospecting_research set status='pending', attempts=greatest(attempts-1,0), updated_at=now() where organization_id=$1 and id=$2 and correlation_id=$3 and status='processing'",
        [linha.organization_id, linha.id, linha.correlation_id],
      );
      continue;
    }
    const r = await analisarPesquisa(pool, linha, chamar);
    if (r.ok) analisadas++;
    else falhas++;
  }
  return { enfileiradas, analisadas, falhas };
}
