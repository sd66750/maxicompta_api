import { Router } from 'express';
import { z } from 'zod';
import { extname } from 'node:path';
import multer from 'multer';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query, getPool, getCurrentDatabaseName, mssql } from '../../db/pool.js';

export const piecesRouter = Router();

// Upload en mémoire (le fichier est stocké en blob dans la base GED).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/**
 * Pièces jointes (GED). Les fichiers sont stockés en blob dans la base PARTAGÉE
 * PrismaGestionCommerciale_document.dbo.PrismaSoft_GED (requête cross-database
 * sur le même serveur), liés par (maTable, idTable) et cloisonnés par
 * bddSociete = nom de la base société courante (comme le legacy).
 */
const GED_TABLE = 'PrismaGestionCommerciale_document.dbo.PrismaSoft_GED';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/**
 * GET /api/pieces?maTable=&idTable=
 * Liste des métadonnées des pièces jointes d'un enregistrement (sans le blob).
 */
piecesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { maTable, idTable } = z
      .object({ maTable: z.string().min(1), idTable: z.coerce.number().int() })
      .parse(req.query);
    const bddSociete = await getCurrentDatabaseName();
    try {
      const rows = await query(
        `SELECT id, nomFichier, extension, type, commentaire
           FROM ${GED_TABLE}
          WHERE maTable = @maTable AND idTable = @idTable
            AND (bddSociete = @bddSociete OR bddSociete IS NULL)
          ORDER BY id`,
        { maTable, idTable, bddSociete: bddSociete ?? null }
      );
      res.json(rows);
    } catch {
      // Base GED absente ou inaccessible sur ce serveur → aucune pièce.
      res.json([]);
    }
  })
);

/**
 * GET /api/pieces/counts?maTable=&idTables=1,2,3
 * Renvoie le nombre de pièces jointes par enregistrement { "1": 2, "3": 1 }.
 */
piecesRouter.get(
  '/counts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { maTable, idTables } = z
      .object({
        maTable: z.string().min(1),
        idTables: z.string().transform((s) => s.split(',').map((n) => Number(n)).filter((n) => Number.isInteger(n))),
      })
      .parse(req.query);
    if (idTables.length === 0) return res.json({});
    const bddSociete = await getCurrentDatabaseName();
    try {
      const rows = await query<{ idTable: number; n: number }>(
        `SELECT idTable, COUNT(id) AS n
           FROM ${GED_TABLE}
          WHERE maTable = @maTable AND idTable IN (${idTables.join(',')})
            AND (bddSociete = @bddSociete OR bddSociete IS NULL)
          GROUP BY idTable`,
        { maTable, bddSociete: bddSociete ?? null }
      );
      const map: Record<number, number> = {};
      for (const r of rows) map[r.idTable] = r.n;
      res.json(map);
    } catch {
      res.json({});
    }
  })
);

interface FichierRow {
  nomFichier: string | null;
  extension: string | null;
  fichier: Buffer | null;
}

/**
 * GET /api/pieces/:id/content  — renvoie le fichier (inline pour PDF/images).
 */
piecesRouter.get(
  '/:id/content',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    const rows = await query<FichierRow>(
      `SELECT nomFichier, extension, ISNULL(fichier, image) AS fichier FROM ${GED_TABLE} WHERE id = @id`,
      { id }
    );
    const row = rows[0];
    if (!row || !row.fichier) throw new HttpError(404, 'Pièce introuvable.');

    const ext = (row.extension ?? '').toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    const inline = mime.startsWith('image/') || mime === 'application/pdf';
    const nom = row.nomFichier ?? `piece${ext}`;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(nom)}"`);
    res.send(row.fichier);
  })
);

/**
 * POST /api/pieces  (multipart : maTable, idTable, [commentaire], file)
 * Ajoute une pièce jointe (blob) à un enregistrement dans la base GED.
 */
piecesRouter.post(
  '/',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { maTable, idTable, commentaire } = z
      .object({ maTable: z.string().min(1), idTable: z.coerce.number().int(), commentaire: z.string().optional() })
      .parse(req.body);
    const file = req.file;
    if (!file) throw new HttpError(400, 'Aucun fichier fourni.');

    const ext = extname(file.originalname).toLowerCase() || '';
    const bddSociete = await getCurrentDatabaseName();

    const pool = await getPool();
    const request = pool.request();
    request.input('fichier', mssql.VarBinary(mssql.MAX), file.buffer);
    request.input('maTable', maTable);
    request.input('idTable', idTable);
    request.input('extension', ext);
    request.input('nomFichier', file.originalname);
    request.input('commentaire', commentaire ?? null);
    request.input('bddSociete', bddSociete ?? null);
    await request.query(
      `INSERT INTO ${GED_TABLE} (fichier, maTable, idTable, extension, nomFichier, commentaire, bddSociete)
       VALUES (@fichier, @maTable, @idTable, @extension, @nomFichier, @commentaire, @bddSociete)`
    );
    res.status(201).json({ ok: true });
  })
);

/** DELETE /api/pieces/:id — supprime une pièce jointe. */
piecesRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    await query(`DELETE FROM ${GED_TABLE} WHERE id = @id`, { id });
    res.json({ ok: true });
  })
);
