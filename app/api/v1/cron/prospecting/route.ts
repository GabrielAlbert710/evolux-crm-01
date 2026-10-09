import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { tickProspecting } from "@/lib/prospecting/worker";
import { tickHunter } from "@/lib/prospecting/hunter/worker";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function handle(req: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(req))
    return fail("forbidden", "Credencial de execução inválida.", 403, { requestId });
  try {
    const prospeccao = await tickProspecting(getRequestPool(), createAdminClient());
    // [fork Evolux] Hunter na mesma batida (docs/evolux/hunter.md). Falha dele
    // não derruba a prospecção: vai para o log e para a resposta.
    let hunter: Awaited<ReturnType<typeof tickHunter>> | { error: string };
    try {
      // Limite e prazo curtos: o scheduler corta esta rota em 240s, e a prospecção vem antes.
      hunter = await tickHunter(getRequestPool(), { limite: 2, prazoMs: 50_000 });
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      logger.error("[prospecting.cron] tickHunter lançou", { error: detalhe, requestId });
      hunter = { error: detalhe };
    }
    return ok({ ...prospeccao, hunter }, { requestId });
  } catch (err) {
    // O `catch` era SEM PARÂMETRO: o objeto do erro não ficava de fora do log,
    // ele era DESCARTADO — não existia em variável nenhuma. Num cron, que roda
    // sozinho e sem ninguém olhando, isso significava que a prospecção da
    // instalação inteira podia parar e a única evidência ser um 500 numa
    // resposta que ninguém lê.
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting.cron] tickProspecting lançou", { error: detalhe, requestId });
    // O detalhe vai na resposta, como o routing-worker faz: quem chama o cron à
    // mão para investigar merece ler a causa, não uma frase genérica.
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
export const GET = handle;
export const POST = handle;
