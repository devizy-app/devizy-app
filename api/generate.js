// api/generate.js — Fonction serverless Vercel (Node)
// Sécurisé : le prompt, le modèle et max_tokens sont construits ICI, jamais côté client.
// Le client envoie uniquement { transcription, catalogue, metier }.

// Plafond d'exécution (Vercel bride selon le plan ; Hobby = 10s, Pro = plus).
export const config = { maxDuration: 30 };

// Rate-limit best-effort en mémoire : freine les abus basiques.
// LIMITE : l'état est par-instance et remis à zéro à froid. À remplacer par
// un store durable (Vercel KV / Upstash Redis) en S2, avant la beta payante.
const RL_FENETRE_MS = 10 * 60 * 1000; // 10 min
const RL_MAX = 15;                    // 15 requêtes / fenêtre / IP
const rlStore = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (rlStore.get(ip) || []).filter((t) => now - t < RL_FENETRE_MS);
  hits.push(now);
  rlStore.set(ip, hits);
  // Purge opportuniste pour éviter la croissance mémoire
  if (rlStore.size > 5000) {
    for (const [k, v] of rlStore) {
      if (!v.length || now - v[v.length - 1] > RL_FENETRE_MS) rlStore.delete(k);
    }
  }
  return hits.length > RL_MAX;
}

export default async function handler(req, res) {
  // CORS / origine : verrouillé sur le domaine de l'app si ALLOWED_ORIGIN est défini
  const allowed = process.env.ALLOWED_ORIGIN || '';
  const origin = req.headers.origin || '';
  if (allowed) {
    if (origin && origin !== allowed) {
      return res.status(403).json({ ok: false, error: 'Origine non autorisée' });
    }
    res.setHeader('Access-Control-Allow-Origin', allowed);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
  }

  // Limitation de débit (best-effort)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnu';
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Trop de requêtes, réessayez dans quelques minutes' });
  }

  try {
    const body = req.body || {};
    const transcription = typeof body.transcription === 'string' ? body.transcription.trim() : '';
    const catalogue = Array.isArray(body.catalogue) ? body.catalogue : [];
    const metier = typeof body.metier === 'string' ? body.metier.slice(0, 40) : '';

    // ── Validation stricte des entrées ──
    if (!transcription || transcription.length < 10) {
      return res.status(400).json({ ok: false, error: 'Transcription trop courte' });
    }
    if (transcription.length > 4000) {
      return res.status(400).json({ ok: false, error: 'Transcription trop longue (4000 caractères max)' });
    }
    if (catalogue.length > 200) {
      return res.status(400).json({ ok: false, error: 'Catalogue trop volumineux (200 prestations max)' });
    }

    // Catalogue nettoyé et indexé : l'IA référence "ref", les prix réels
    // sont relus côté client depuis le catalogue local (zéro dérive de prix).
    const cat = catalogue.slice(0, 200).map((c, i) => ({
      ref: i,
      nom: String(c.nom || '').slice(0, 120),
      prix: Number(c.prix) || 0,
      unite: String(c.unite || 'forfait').slice(0, 12)
    }));
    const catalogueTexte = cat
      .map((c) => `[${c.ref}] ${c.nom} — ${c.prix} €/${c.unite}`)
      .join('\n');

    const systemPrompt =
      'Tu es un assistant qui structure des devis pour artisans du bâtiment' +
      (metier ? ` (métier : ${metier})` : '') +
      '. À partir de la dictée vocale de l\'artisan, tu identifies les prestations, quantités et unités.\n\n' +
      'RÈGLES :\n' +
      '1. Si une prestation correspond à une entrée du catalogue ci-dessous, renvoie son numéro dans "ref" et ne renvoie PAS de prix (il sera relu depuis le catalogue).\n' +
      '2. Si aucune entrée ne correspond, mets "ref": null et propose un libellé clair, une unité et un prix unitaire HT réaliste pour le marché français.\n' +
      '3. Les quantités viennent de la dictée. Si une quantité est absente, mets 1.\n' +
      '4. N\'invente JAMAIS de prestation non mentionnée dans la dictée.\n' +
      '5. Réponds UNIQUEMENT avec un objet JSON valide, sans backticks ni texte autour, au format :\n' +
      '{"description_globale": "résumé en moins de 12 mots", "lignes": [{"ref": 0, "quantite": 1}, {"ref": null, "libelle": "...", "quantite": 2, "unite": "m2", "prix_unitaire": 45, "cout_achat": 0}]}\n\n' +
      'CATALOGUE DE L\'ARTISAN :\n' + (catalogueTexte || '(catalogue vide)');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY manquante');
      return res.status(500).json({ ok: false, error: 'Configuration serveur incomplète' });
    }

    // Timeout dur : évite qu'une génération lente ne dépasse la limite Vercel en 504 brut
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let anthropicResp;
    try {
      anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: systemPrompt,
          messages: [{ role: 'user', content: 'Dictée de l\'artisan :\n\n' + transcription }]
        }),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timeout);
      if (e && e.name === 'AbortError') {
        console.error('Timeout API Anthropic');
        return res.status(504).json({ ok: false, error: 'La génération a pris trop de temps, veuillez réessayer' });
      }
      throw e;
    }
    clearTimeout(timeout);

    if (!anthropicResp.ok) {
      const errTxt = await anthropicResp.text();
      console.error('Erreur API Anthropic', anthropicResp.status, errTxt.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'Le service de génération est momentanément indisponible' });
    }

    const data = await anthropicResp.json();
    const texte = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    let devis;
    try {
      devis = JSON.parse(texte);
    } catch (e) {
      console.error('Réponse IA non parsable :', texte.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'Réponse IA invalide, veuillez réessayer' });
    }

    if (!devis || !Array.isArray(devis.lignes) || devis.lignes.length === 0) {
      return res.status(502).json({ ok: false, error: 'Aucune prestation détectée dans la dictée' });
    }

    // Sanitation de sortie : on ne renvoie que les champs attendus
    const lignes = devis.lignes.slice(0, 40).map((l) => ({
      ref: Number.isInteger(l.ref) && l.ref >= 0 && l.ref < cat.length ? l.ref : null,
      libelle: String(l.libelle || '').slice(0, 160),
      quantite: Number(l.quantite) > 0 ? Number(l.quantite) : 1,
      unite: String(l.unite || 'forfait').slice(0, 12),
      prix_unitaire: Number(l.prix_unitaire) >= 0 ? Number(l.prix_unitaire) : 0,
      cout_achat: Number(l.cout_achat) >= 0 ? Number(l.cout_achat) : 0
    }));

    return res.status(200).json({
      ok: true,
      devis: {
        description_globale: String(devis.description_globale || '').slice(0, 120),
        lignes
      }
    });
  } catch (err) {
    console.error('Erreur /api/generate :', err);
    return res.status(500).json({ ok: false, error: 'Erreur interne, veuillez réessayer' });
  }
}
