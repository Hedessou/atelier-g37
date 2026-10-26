-- Check-list de maintenance clg : fiche papier « Benin Textiles S.A. — Ring Frame G37 » (34 points en 6 zones).
-- Remplace le modèle de départ (aucune check-list n'avait encore été remplie). Appliquée le 26/10/2026.
-- Format « Zone — point » : l'app affiche un titre par zone avec « Tout cocher ».
INSERT INTO checklist_steps (id, position, text, created_by, updated_at)
SELECT 'cl_' || lpad(n::text, 2, '0'), n * 10, t, 'Fiche Benin Textiles', now()
FROM (VALUES
  (1,  'All gearing drives — Gearing matching & condition'),
  (2,  'All gearing drives — All belts condition check'),
  (3,  'Drafting section zone — Top roller buffing'),
  (4,  'Drafting section zone — Front, middle & back bottom roller checking'),
  (5,  'Drafting section zone — Bottom and top apron checking'),
  (6,  'Drafting section zone — Top arm condition checking'),
  (7,  'Drafting section zone — Bobbin holder and creel alignment checking'),
  (8,  'Drafting section zone — Roving guide & tension pulley cleaning & checking'),
  (9,  'Drafting section zone — Spindle brake & bolster cleaning & checking'),
  (10, 'Drafting section zone — Clamping crown & gliding ring cleaning & checking'),
  (11, 'Drafting section zone — Drum pulley & jockey pulley cleaning & centering checking'),
  (12, 'Drafting section zone — Ring rail, lappet height setting, ring, ABC ring gauge checking'),
  (13, 'Doffer servo disc zone — Servo disc pulley cleaning & checking'),
  (14, 'Doffer servo disc zone — Traction strap & doffer pin checking'),
  (15, 'Doffer servo disc zone — Bottom & top carrier and bottom peg checking'),
  (16, 'Doffer servo disc zone — Gripper & gripper membrane checking'),
  (17, 'Doffer servo disc zone — Profile condition checking'),
  (18, 'Doffer servo disc zone — Link-pulley cleaning & checking'),
  (19, 'Settings — Bottom roller & saddle gauge setting'),
  (20, 'Settings — Gripper rail setting check'),
  (21, 'Settings — Doffer bottom height setting & servodisc centering check'),
  (22, 'Settings — All pneumatic systems and air leakage checking'),
  (23, 'Settings — Rotary drum head stock and foot stock'),
  (24, 'Settings — All sensor & valve settings'),
  (25, 'Lubrication — Front, middle & back bottom roller greasing'),
  (26, 'Lubrication — All gearing greasing'),
  (27, 'Lubrication — Ring rail gear box oil level checking'),
  (28, 'Lubrication — Doffer gear box oil level checking & change'),
  (29, 'Lubrication — Servo disc gear box oil level check / change'),
  (30, 'Lubrication — Gearing oil lubricator level checking & topping'),
  (31, 'Lubrication — Drum shaft lubrication'),
  (32, 'Lubrication — Spindle oil change'),
  (33, 'Overhead cleaner (OHTC) — OHTC pipe & wheel checking'),
  (34, 'Overhead cleaner (OHTC) — OHTC nozzles & its position checking')
) AS v(n, t)
ON CONFLICT (id) DO UPDATE SET text = excluded.text, position = excluded.position, created_by = excluded.created_by, updated_at = now();
