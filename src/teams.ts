// Lagnamnsmappning: Excel-arket använder svenska namn, API-Football engelska.
// `normalize` gör jämförelser robusta (gemener, utan diakriter/skiljetecken).

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // ta bort diakriter (ç, ö, é …)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Svenska lagnamn (exakt som i Excel) → kanoniskt engelskt namn. */
export const SWEDISH_TO_ENGLISH: Record<string, string> = {
  Mexiko: "Mexico",
  Sydafrika: "South Africa",
  Sydkorea: "South Korea",
  Tjeckien: "Czech Republic",
  Kanada: "Canada",
  "Bosnien och Herce.": "Bosnia and Herzegovina",
  Qatar: "Qatar",
  Schweiz: "Switzerland",
  Brasilien: "Brazil",
  Marocko: "Morocco",
  Haiti: "Haiti",
  Skottland: "Scotland",
  USA: "USA",
  Paraguay: "Paraguay",
  Australien: "Australia",
  Turkiet: "Turkey",
  Tyskland: "Germany",
  "Curaçao": "Curacao",
  Elfenbenskusten: "Ivory Coast",
  Ecuador: "Ecuador",
  Nederländerna: "Netherlands",
  Japan: "Japan",
  Sverige: "Sweden",
  Tunisien: "Tunisia",
  Belgien: "Belgium",
  Egypten: "Egypt",
  Iran: "Iran",
  "Nya Zeeland": "New Zealand",
  Spanien: "Spain",
  "Kap Verde": "Cape Verde",
  Saudiarabien: "Saudi Arabia",
  Uruguay: "Uruguay",
  Frankrike: "France",
  Senegal: "Senegal",
  Irak: "Iraq",
  Norge: "Norway",
  Argentina: "Argentina",
  Algeriet: "Algeria",
  Österrike: "Austria",
  Jordanien: "Jordan",
  Portugal: "Portugal",
  "DR Kongo": "DR Congo",
  Uzbekistan: "Uzbekistan",
  Colombia: "Colombia",
  England: "England",
  Kroatien: "Croatia",
  Ghana: "Ghana",
  Panama: "Panama",
};

/**
 * Varianter på engelska namn som API-Football kan returnera → vårt kanoniska namn.
 * Nycklar är normaliserade. Lägg till fler här om importen rapporterar omappade lag.
 */
export const ENGLISH_ALIASES: Record<string, string> = {
  "korea republic": "South Korea",
  czechia: "Czech Republic",
  turkiye: "Turkey",
  "cote d ivoire": "Ivory Coast",
  "cape verde islands": "Cape Verde",
  "congo dr": "DR Congo",
  "dr congo": "DR Congo",
  bosnia: "Bosnia and Herzegovina",
  "bosnia herzegovina": "Bosnia and Herzegovina", // API: "Bosnia & Herzegovina"
  "united states": "USA",
};

/** Svenskt namn → kanoniskt engelskt namn (eller null om okänt). */
export function fromSwedish(name: string): string | null {
  return SWEDISH_TO_ENGLISH[name.trim()] ?? null;
}

/** Engelskt API-namn → kanoniskt namn (hanterar kända varianter). */
export function canonicalizeEnglish(name: string): string {
  return ENGLISH_ALIASES[normalize(name)] ?? name.trim();
}

/** Nyckel för en gruppmatch baserat på lagparet (oberoende av språk/variant). */
export function teamMatchKey(homeCanonical: string, awayCanonical: string): string {
  return `${normalize(homeCanonical)}__${normalize(awayCanonical)}`;
}

const ENGLISH_TO_SWEDISH: Record<string, string> = Object.fromEntries(
  Object.entries(SWEDISH_TO_ENGLISH).map(([sv, en]) => [normalize(en), sv]),
);

/** Engelskt API-namn → svenskt visningsnamn (fallback: namnet som det kom in). */
export function toSwedish(name: string): string {
  const canon = canonicalizeEnglish(name);
  return ENGLISH_TO_SWEDISH[normalize(canon)] ?? name;
}
