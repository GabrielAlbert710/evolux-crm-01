/**
 * [fork Evolux] Roda o Hunter à mão — o mesmo job do cron, sem esperar a batida.
 *
 *   pnpm tsx scripts/evolux-hunter-analisar.ts <campaign_id> [quantas=1] [--forcar]
 *
 * Usa as empresas JÁ gravadas pela prospecção (não busca na Apify), chama o
 * modelo pelo seam oficial (custo em llm_calls) e grava em prospecting_research
 * com auditoria. Não envia nada a ninguém.
 */
import pg from "pg";
import {
  analisarPesquisa,
  chamarModeloPadrao,
  enfileirarPesquisas,
  reivindicar,
} from "@/lib/prospecting/hunter/worker";

async function main() {
  const [campaignId, quantasArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const forcar = process.argv.includes("--forcar");
  if (!campaignId) throw new Error("uso: evolux-hunter-analisar.ts <campaign_id> [quantas] [--forcar]");
  const quantas = Math.max(1, Number(quantasArg ?? 1));
  const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  try {
    const camp = await pool.query<{ organization_id: string; name: string }>(
      "select organization_id, name from prospecting_campaigns where id=$1",
      [campaignId],
    );
    const org = camp.rows[0]?.organization_id;
    if (!org) throw new Error("campanha não encontrada");
    const candidatos = await pool.query<{ id: string }>(
      `select p.id from prospecting_candidates p
        where p.organization_id=$1 and p.campaign_id=$2 and p.suppression_salt is null
          and not exists (select 1 from prospecting_research r where r.organization_id=p.organization_id
                           and r.candidate_id=p.id and r.status='completed' and not $4::boolean)
        order by p.created_at limit $3`,
      [org, campaignId, quantas, forcar],
    );
    const ids = candidatos.rows.map((r) => r.id);
    if (!ids.length) {
      console.info(JSON.stringify({ campanha: camp.rows[0]!.name, mensagem: "nada a analisar" }));
      return;
    }
    const fila = await enfileirarPesquisas(pool, org, campaignId, { candidateIds: ids, forcar });
    const chamar = chamarModeloPadrao(pool);
    const saida = [];
    for (const linha of await reivindicar(pool, ids.length, org)) {
      const inicio = Date.now();
      const r = await analisarPesquisa(pool, linha, chamar);
      saida.push({ research_id: linha.id, candidate_id: linha.candidate_id, ms: Date.now() - inicio, ...r });
    }
    console.info(JSON.stringify({ campanha: camp.rows[0]!.name, enfileiradas: fila.enfileiradas, resultados: saida }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
