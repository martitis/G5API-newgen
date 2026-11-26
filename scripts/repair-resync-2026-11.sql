-- Repairs what the heartbeat resync bug (fixed 2026-11-22) did to finished matches.
--
-- The bug: the heartbeat compared a get5_status answer up to 15 s old with the panel and "fixed" scores backwards.
-- It also flagged nearly every map stats_incomplete although no round_end was missed. The round history
-- (match_round) is written only by round_end, so it is the trustworthy source here.
--
-- Usage (MySQL 8):
--   1. Set the match range below (LAN 20-22 Nov 2026: 156-225).
--   2. Run part 1 alone and read the preview.
--   3. Run part 2, which commits.
-- Take a backup first: mysqldump get5 map_stats match > before-repair.sql

SET @first_match = 156;
SET @last_match = 225;

-- Last recorded round of every map in the range, and how many rounds are recorded.
DROP TEMPORARY TABLE IF EXISTS repair_rounds;
CREATE TEMPORARY TABLE repair_rounds AS
SELECT r.map_id, r.team1_score, r.team2_score, c.rounds, c.last_round
FROM match_round r
JOIN (
  SELECT map_id, COUNT(*) AS rounds, MAX(round_number) AS last_round
  FROM match_round
  WHERE match_id BETWEEN @first_match AND @last_match
  GROUP BY map_id
) c ON c.map_id = r.map_id AND c.last_round = r.round_number;

-- ===== Part 1: preview (changes nothing) =====

-- Finished maps whose stored score differs from their last recorded round (rolled back after the last round_end).
-- Cancelled matches are left as they are (their maps keep the score the cancellation left).
SELECT ms.match_id, ms.map_number, ms.map_name,
       CONCAT(ms.team1_score, ':', ms.team2_score) AS stored,
       CONCAT(rr.team1_score, ':', rr.team2_score) AS last_round
FROM map_stats ms
JOIN repair_rounds rr ON rr.map_id = ms.id
JOIN `match` m ON m.id = ms.match_id
WHERE ms.match_id BETWEEN @first_match AND @last_match
  AND ms.end_time IS NOT NULL AND NOT COALESCE(m.cancelled, 0)
  AND (ms.team1_score <> rr.team1_score OR ms.team2_score <> rr.team2_score);

-- Maps flagged incomplete although every round is recorded.
SELECT ms.match_id, ms.map_number, ms.map_name, rr.rounds
FROM map_stats ms
JOIN repair_rounds rr ON rr.map_id = ms.id
WHERE ms.match_id BETWEEN @first_match AND @last_match
  AND ms.stats_incomplete = 1
  AND rr.rounds = rr.last_round
  AND rr.last_round = rr.team1_score + rr.team2_score;

-- Finished matches whose series score differs from their map wins.
SELECT m.id, CONCAT(m.team1_score, ':', m.team2_score) AS stored,
       CONCAT(SUM(ms.winner = m.team1_id), ':', SUM(ms.winner = m.team2_id)) AS from_maps
FROM `match` m
JOIN map_stats ms ON ms.match_id = m.id AND ms.end_time IS NOT NULL
WHERE m.id BETWEEN @first_match AND @last_match
  AND m.end_time IS NOT NULL AND NOT COALESCE(m.cancelled, 0) AND NOT COALESCE(m.forfeit, 0)
GROUP BY m.id, m.team1_score, m.team2_score
HAVING SUM(ms.winner = m.team1_id) <> m.team1_score OR SUM(ms.winner = m.team2_id) <> m.team2_score;

-- ===== Part 2: repair =====
START TRANSACTION;

-- Final map scores (and the map winner, which map_result set from the real result) from the last recorded round.
UPDATE map_stats ms
JOIN repair_rounds rr ON rr.map_id = ms.id
JOIN `match` m ON m.id = ms.match_id
SET ms.team1_score = rr.team1_score, ms.team2_score = rr.team2_score, ms.round_number = rr.last_round
WHERE ms.match_id BETWEEN @first_match AND @last_match
  AND ms.end_time IS NOT NULL AND NOT COALESCE(m.cancelled, 0)
  AND (ms.team1_score <> rr.team1_score OR ms.team2_score <> rr.team2_score);

-- Not incomplete when every round from 1 to the last one has its round_end recorded.
UPDATE map_stats ms
JOIN repair_rounds rr ON rr.map_id = ms.id
SET ms.stats_incomplete = 0
WHERE ms.match_id BETWEEN @first_match AND @last_match
  AND ms.stats_incomplete = 1
  AND rr.rounds = rr.last_round
  AND rr.last_round = rr.team1_score + rr.team2_score;

-- Series score from the map winners (normal finished matches only; forfeits keep theirs).
UPDATE `match` m
JOIN (
  SELECT ms.match_id,
         SUM(ms.winner = mm.team1_id) AS t1,
         SUM(ms.winner = mm.team2_id) AS t2
  FROM map_stats ms
  JOIN `match` mm ON mm.id = ms.match_id
  WHERE ms.match_id BETWEEN @first_match AND @last_match AND ms.end_time IS NOT NULL
  GROUP BY ms.match_id
) w ON w.match_id = m.id
SET m.team1_score = w.t1, m.team2_score = w.t2
WHERE m.end_time IS NOT NULL AND NOT COALESCE(m.cancelled, 0) AND NOT COALESCE(m.forfeit, 0)
  AND (m.team1_score <> w.t1 OR m.team2_score <> w.t2);

COMMIT;
DROP TEMPORARY TABLE IF EXISTS repair_rounds;

-- Applied to production on 2026-11-26 (matches 156-225): 7 final scores fixed, 59 stats_incomplete flags
-- cleared, no series score changed. Not fixed: two map rows the bug inserted in cancelled matches (156 map 1,
-- 189 map 2: a copied score, no rounds); one of them has a kill event attached, so they were kept.
--
-- Afterwards: POST /tournaments/:id/refresh for any tournament whose matches changed winner (none expected: the
-- winner comes from map_result/series_end, which this doesn't touch).
