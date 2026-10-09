/**
 * [fork Evolux] O saneamento da saída do Hunter — a parte que NÃO depende de o
 * modelo obedecer ao prompt.
 *
 * Toda regra que dá para medir contra os dados de entrada é reaplicada aqui:
 *  - canal de contato (telefone, WhatsApp, e-mail, rede) só sobrevive se
 *    estiver nos dados da prospecção — senão vira null;
 *  - fact sem campo de origem válido, ou cuja evidência não está no campo,
 *    é rebaixado a hipótese (nunca o contrário);
 *  - pessoa e cargo só sobrevivem se aparecem literalmente nos dados; sem
 *    nome, o papel é UNKNOWN (não há como saber se é decisor ou gatekeeper);
 *  - toda dor é POTENTIAL_PAIN nesta etapa;
 *  - o ICP é a SOMA do breakdown com cada critério no seu teto, e a faixa é
 *    calculada aqui — o modelo não escolhe a faixa;
 *  - a confiança tem teto pela completude dos dados.
 *
 * Cada correção vira uma linha em `corrections`, que vai gravada junto: quem
 * audita vê o que o modelo disse e o que o sistema recusou.
 *
 * Pura e sem I/O: é o que os testes exercitam.
 */
import type { ProspectEnrichment } from "../schema";
import {
  CAMPOS_DE_ORIGEM,
  PAPEIS_DE_CONTATO,
  TETOS_DO_ICP,
  hunterResearchSchema,
  type CriterioDoIcp,
  type HunterModelOutput,
  type HunterResearch,
} from "./schema";

export interface EntradaDoHunter {
  empresa: ProspectEnrichment & { phone: string | null };
  campanha: { niche: string | null; location: string | null };
}

const digitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const mesmoTelefone = (a: string, b: string) => {
  const x = digitos(a);
  const y = digitos(b);
  return x.length >= 8 && y.length >= 8 && (x.endsWith(y) || y.endsWith(x));
};
const urlNormal = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
const minusculo = (s: string) => s.trim().toLowerCase();
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const duasCasas = (n: number) => Math.round(n * 100) / 100;

export function faixaDoIcp(score: number): HunterResearch["icp_tier"] {
  if (score >= 80) return "HIGH_FIT";
  if (score >= 65) return "MEDIUM_FIT";
  return "LOW_FIT";
}

/** Fração dos campos úteis presentes — 0 a 1. */
export function completudeDosDados(e: EntradaDoHunter["empresa"]): number {
  const presentes = [
    !!e.phone,
    !!e.website,
    e.emails.length > 0,
    e.socials.length > 0,
    !!e.address,
    !!e.category,
    e.rating !== null,
  ];
  return presentes.filter(Boolean).length / presentes.length;
}

/** Teto da confiança: com tudo presente, 0,9; sem nada, 0,3. */
export const tetoDeConfianca = (completude: number) => duasCasas(0.3 + 0.6 * completude);

function valorDoCampo(e: EntradaDoHunter["empresa"], campo: string): string {
  const v = (e as unknown as Record<string, unknown>)[campo];
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(" ");
  return String(v);
}

export function sanearSaida(bruto: HunterModelOutput, entrada: EntradaDoHunter): HunterResearch {
  const e = entrada.empresa;
  const correcoes: string[] = [];
  const textoDaEmpresa = minusculo(JSON.stringify(e));

  // ── canais de contato: só o que está nos dados ──────────────────────────
  const cc = bruto.contact_channels;
  let phone: string | null = null;
  if (cc.phone) {
    if (e.phone && mesmoTelefone(cc.phone, e.phone)) phone = e.phone;
    else correcoes.push(`telefone descartado (não está nos dados): ${cc.phone}`);
  } else if (e.phone) phone = e.phone;

  let whatsapp: string | null = null;
  if (cc.whatsapp) {
    const doTelefone = e.phone && mesmoTelefone(cc.whatsapp, e.phone);
    // Link de WhatsApp (wa.me, api.whatsapp) que está LITERALMENTE nos dados — no
    // site ou nas redes — também vale: a Apify às vezes grava o wa.me como site.
    const linksDosDados = [e.website, ...e.socials].filter(
      (x): x is string => !!x && /wa\.me|whatsapp/i.test(x),
    );
    const deLink = linksDosDados.find(
      (x) =>
        urlNormal(x) === urlNormal(cc.whatsapp!) ||
        (digitos(x).length >= 8 && mesmoTelefone(x, cc.whatsapp!)),
    );
    if (doTelefone) whatsapp = cc.whatsapp;
    else if (deLink) whatsapp = deLink;
    else correcoes.push(`WhatsApp descartado (não está nos dados): ${cc.whatsapp}`);
  }

  let email: string | null = null;
  if (cc.email) {
    const achado = e.emails.find((x) => minusculo(x) === minusculo(cc.email!));
    if (achado) email = achado;
    else correcoes.push(`e-mail descartado (não está nos dados): ${cc.email}`);
  } else if (e.emails.length) email = e.emails[0]!;

  const sociaisDosDados = new Map(e.socials.map((s) => [urlNormal(s), s]));
  const social: string[] = [];
  for (const s of cc.social) {
    const original = sociaisDosDados.get(urlNormal(s));
    if (original) social.push(original);
    else correcoes.push(`rede social descartada (não está nos dados): ${s}`);
  }
  if (!cc.social.length) social.push(...e.socials);

  const website: string | null = e.website;
  if (bruto.website && (!e.website || urlNormal(bruto.website) !== urlNormal(e.website)))
    correcoes.push(`site trocado pelo dos dados: ${bruto.website}`);

  // ── facts: fonte válida e evidência presente no campo, senão hipótese ──
  const facts: HunterResearch["facts"] = [];
  const hypotheses: HunterResearch["hypotheses"] = [];
  for (const f of bruto.facts) {
    if (!f.statement) continue;
    const fonte = (f.source ?? "").trim();
    const evidencia = (f.evidence ?? "").trim();
    const valido = (CAMPOS_DE_ORIGEM as readonly string[]).includes(fonte);
    const valor = valido ? minusculo(valorDoCampo(e, fonte)) : "";
    const confere =
      valor !== "" &&
      evidencia !== "" &&
      (valor.includes(minusculo(evidencia)) || minusculo(evidencia).includes(valor));
    if (valido && confere)
      facts.push({ statement: f.statement, source: fonte as (typeof CAMPOS_DE_ORIGEM)[number], evidence: evidencia });
    else {
      correcoes.push(`fact sem evidência nos dados virou hipótese: ${f.statement}`);
      hypotheses.push({
        statement: f.statement,
        confidence: 0.3,
        how_to_validate: "Confirmar em fonte pública ou na conversa com a empresa.",
      });
    }
  }
  for (const h of bruto.hypotheses) {
    if (!h.statement) continue;
    hypotheses.push({
      statement: h.statement,
      confidence: duasCasas(clamp01(h.confidence)),
      how_to_validate: h.how_to_validate,
    });
  }

  // ── dores: nesta etapa, sempre potenciais ───────────────────────────────
  const pain_signals = bruto.pain_signals
    .filter((p) => p.statement)
    .map((p) => {
      if (p.status !== "POTENTIAL_PAIN")
        correcoes.push(`dor rebaixada para POTENTIAL_PAIN (era ${p.status}): ${p.statement}`);
      return { statement: p.statement, status: "POTENTIAL_PAIN" as const };
    });

  // ── pessoas: só quem aparece nos dados ──────────────────────────────────
  const possible_contacts: HunterResearch["possible_contacts"] = [];
  for (const c of bruto.possible_contacts) {
    const nome = c.name?.trim() || null;
    const nomeConfere = !!nome && nome.length >= 3 && textoDaEmpresa.includes(minusculo(nome));
    if (nome && !nomeConfere) correcoes.push(`pessoa descartada (não está nos dados): ${nome}`);
    const cargo = c.role?.trim() || null;
    const cargoConfere = !!cargo && nomeConfere && textoDaEmpresa.includes(minusculo(cargo));
    if (cargo && !cargoConfere) correcoes.push(`cargo descartado (não está nos dados): ${cargo}`);
    const papel = (PAPEIS_DE_CONTATO as readonly string[]).includes(c.contact_role)
      ? (c.contact_role as (typeof PAPEIS_DE_CONTATO)[number])
      : "UNKNOWN";
    const papelFinal = nomeConfere ? papel : "UNKNOWN";
    if (papel !== papelFinal) correcoes.push(`papel ${papel} sem pessoa identificada virou UNKNOWN`);
    const fonte = c.source && (CAMPOS_DE_ORIGEM as readonly string[]).includes(c.source) ? c.source : null;
    possible_contacts.push({
      name: nomeConfere ? nome : null,
      role: cargoConfere ? cargo : null,
      contact_role: papelFinal,
      source: nomeConfere ? fonte : null,
      confidence: nomeConfere ? duasCasas(clamp01(c.confidence)) : 0,
    });
  }
  // Um "desconhecido" basta; vários iguais não dizem nada a mais.
  const contatos = possible_contacts.filter(
    (c, i, todos) =>
      c.name !== null || todos.findIndex((o) => o.name === null) === i,
  );
  const decisor = contatos.find((c) => c.contact_role === "DECISION_MAKER" && c.name);

  // ── ICP: soma do breakdown, cada critério no seu teto ───────────────────
  const breakdown = {} as Record<CriterioDoIcp, number>;
  for (const [criterio, teto] of Object.entries(TETOS_DO_ICP) as [CriterioDoIcp, number][]) {
    const bruto_ = Math.round(Number(bruto.score_breakdown[criterio]) || 0);
    const v = Math.min(teto, Math.max(0, bruto_));
    if (v !== bruto_) correcoes.push(`${criterio} ajustado ao limite: ${bruto_} → ${v}`);
    breakdown[criterio] = v;
  }
  const icp_score = Object.values(breakdown).reduce((a, b) => a + b, 0);

  // ── confiança: teto pela completude dos dados ───────────────────────────
  const teto = tetoDeConfianca(completudeDosDados(e));
  const pedida = duasCasas(clamp01(bruto.confidence));
  const confidence = Math.min(pedida, teto);
  if (confidence < pedida) correcoes.push(`confiança limitada pela completude dos dados: ${pedida} → ${confidence}`);

  return hunterResearchSchema.parse({
    company: bruto.company || e.name,
    segment: bruto.segment,
    subsegment: bruto.subsegment,
    location: bruto.location || e.address || "",
    website,
    contact_channels: { phone, whatsapp, email, social },
    facts,
    hypotheses,
    pain_signals,
    opportunity_signals: bruto.opportunity_signals.filter(Boolean),
    possible_contacts: contatos,
    responsible_person: decisor?.name ?? "UNKNOWN",
    score_breakdown: breakdown,
    icp_score,
    icp_tier: faixaDoIcp(icp_score),
    confidence,
    recommended_angle: bruto.recommended_angle,
    disqualifiers: bruto.disqualifiers.filter(Boolean),
    recommended_next_action: bruto.recommended_next_action,
    research_summary: bruto.research_summary,
    provenance: "prospecting_source",
    corrections: correcoes,
  });
}

/** Extrai o primeiro objeto JSON da resposta (o modelo às vezes embrulha em ```json). */
export function extrairJson(texto: string): unknown {
  const limpo = texto.replace(/```(?:json)?/gi, "").trim();
  const inicio = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (inicio < 0 || fim <= inicio) throw new Error("resposta do modelo sem objeto JSON");
  return JSON.parse(limpo.slice(inicio, fim + 1));
}
