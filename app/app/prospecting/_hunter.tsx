"use client";
/**
 * [fork Evolux] Hunter na tela de Prospecção — barra da campanha + análise por
 * empresa. Isolado aqui para que `_client.tsx` (oficial) receba só duas linhas.
 * Lê `/api/v1/prospecting/research`; a análise roda no cron (docs/evolux/hunter.md).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { HunterResearch } from "@/lib/prospecting/hunter/schema";

type Pesquisa = {
  id: string;
  candidate_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  icp_score: number | null;
  icp_tier: HunterResearch["icp_tier"] | null;
  confidence: string | number | null;
  result: HunterResearch | null;
  error: string | null;
  completed_at: string | null;
  updated_at: string;
};

const ROTULO_DO_STATUS: Record<Pesquisa["status"], string> = {
  pending: "Análise na fila",
  processing: "Analisando…",
  completed: "Analisada",
  failed: "Análise falhou",
};
const ROTULO_DA_FAIXA: Record<HunterResearch["icp_tier"], string> = {
  HIGH_FIT: "Fit alto",
  MEDIUM_FIT: "Fit médio",
  LOW_FIT: "Fit baixo",
};

function usePesquisas(campaignId: string) {
  return useQuery({
    queryKey: ["prospecting-research", campaignId],
    queryFn: async () =>
      (
        await apiClient.get<{ data: { research: Pesquisa[] } }>(
          `/api/v1/prospecting/research?campaign_id=${campaignId}`,
        )
      ).data.research,
    refetchInterval: 10000,
  });
}

async function pedirAnalise(campaignId: string, candidateIds?: string[], force?: boolean) {
  await apiClient.post("/api/v1/prospecting/research", {
    action: "analyze",
    campaign_id: campaignId,
    ...(candidateIds ? { candidate_ids: candidateIds } : {}),
    ...(force ? { force } : {}),
  });
}

export function HunterBarra({ campaignId, total }: { campaignId: string; total: number }) {
  const t = useT();
  const query = usePesquisas(campaignId);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const linhas = query.data ?? [];
  const conta = (s: Pesquisa["status"]) => linhas.filter((l) => l.status === s).length;
  async function analisar(force: boolean) {
    setBusy(true);
    setErro(null);
    try {
      await pedirAnalise(campaignId, undefined, force);
      await query.refetch();
    } catch (e) {
      setErro(e instanceof Error ? e.message : t("Não foi possível enfileirar a análise."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
      <div>
        <p className="font-medium">{t("Hunter · inteligência comercial")}</p>
        <p className="text-xs text-muted-foreground">
          {conta("completed")} {t("de")} {total} {t("analisadas")} · {conta("pending") + conta("processing")}{" "}
          {t("na fila")} · {conta("failed")} {t("com falha")}. {t("Nenhuma mensagem é enviada nesta etapa.")}
        </p>
        {erro && <p className="mt-1 text-xs text-destructive">{erro}</p>}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => analisar(false)}>
          {t("Analisar empresas")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => analisar(true)}>
          {t("Reanalisar todas")}
        </Button>
      </div>
    </div>
  );
}

export function HunterCelula({ campaignId, candidateId }: { campaignId: string; candidateId: string }) {
  const t = useT();
  const query = usePesquisas(campaignId);
  const [busy, setBusy] = useState(false);
  const p = query.data?.find((l) => l.candidate_id === candidateId);
  if (!p) return null;
  const r = p.result;
  const confianca = p.confidence === null ? null : Number(p.confidence);
  return (
    <div className="mt-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        {p.status === "completed" && p.icp_score !== null && p.icp_tier ? (
          <Badge variant={p.icp_tier === "HIGH_FIT" ? "default" : "outline"}>
            ICP {p.icp_score} · {t(ROTULO_DA_FAIXA[p.icp_tier])}
          </Badge>
        ) : (
          <Badge variant="outline">{t(ROTULO_DO_STATUS[p.status])}</Badge>
        )}
        {confianca !== null && p.status === "completed" && (
          <span className="text-muted-foreground">
            {t("confiança")} {Math.round(confianca * 100)}%
          </span>
        )}
      </div>
      {p.status === "failed" && p.error && <p className="mt-1 text-muted-foreground">{p.error}</p>}
      {r && (
        <details className="mt-1 max-w-80">
          <summary className="cursor-pointer underline">{t("Ver análise do Hunter")}</summary>
          <div className="mt-2 space-y-2">
            <p>{r.research_summary}</p>
            <p>
              <strong>{t("Ângulo recomendado:")}</strong> {r.recommended_angle}
            </p>
            <p>
              <strong>{t("Próxima ação:")}</strong> {r.recommended_next_action}
            </p>
            <p>
              <strong>{t("Responsável:")}</strong>{" "}
              {r.responsible_person === "UNKNOWN" ? t("não identificado") : r.responsible_person}
            </p>
            <Lista titulo={t("Fatos")} itens={r.facts.map((f) => `${f.statement} (${f.source})`)} />
            <Lista
              titulo={t("Hipóteses")}
              itens={r.hypotheses.map(
                (h) => `${h.statement} — ${Math.round(h.confidence * 100)}%. ${h.how_to_validate}`,
              )}
            />
            <Lista titulo={t("Sinais de oportunidade")} itens={r.opportunity_signals} />
            <Lista titulo={t("Dores potenciais")} itens={r.pain_signals.map((d) => d.statement)} />
            <Lista titulo={t("Pontos de atenção")} itens={r.disqualifiers} />
            {p.completed_at && (
              <p className="text-muted-foreground">
                {t("Analisada em")} {new Date(p.completed_at).toLocaleString()}
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await pedirAnalise(campaignId, [candidateId], true);
                  await query.refetch();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Reanalisar")}
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}

function Lista({ titulo, itens }: { titulo: string; itens: string[] }) {
  if (!itens.length) return null;
  return (
    <div>
      <p className="font-medium">{titulo}</p>
      <ul className="list-disc pl-4">
        {itens.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
