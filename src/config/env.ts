import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Variable d'environnement manquante : ${name}. Copiez .env.example vers .env et renseignez-la.`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  configKey: required('PRISMA_CONFIG_KEY'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  // Dossier du build front à servir (prod). Vide en dev (Vite s'en charge).
  clientDist: process.env.CLIENT_DIST ?? '',
};
