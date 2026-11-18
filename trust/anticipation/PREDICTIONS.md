# Pre-registration: can a consumer headband's EEG be anticipated, and how far ahead?

Written and committed before any forecasting run. Everything below is decided here; the run only fills in numbers.

## Question

Given the last 16 s of a Muse recording, how well can the next 2, 4, 8 and 16 s be predicted, on this person's own head and on the lab's cold-exposure recordings, when every claim must pass the same gates the lab's papers use?

## Data (what is on this laptop on 2026-11-18)

Pools are assigned from the recording's filename stamp and folder; nothing is hand-picked after seeing results.

- **mine**: recordings this laptop's owner tagged as his own head: the recorder-building period (2025-12-01 to 2026-01-15, `Muse1` files only, "tested on the author's own head while it was written"), the Feb 25 pre-plunge sitting (`AlexBefore`), the Nov 4 table session, and the Oct 27 night (reported separately as `mine_sleep`).
- **cold**: recordings from the lab's cold-exposure periods, wearer mixed and mostly unnamed: 2026-01-16 to 01-31 (snow and cold), 2026-02-01 to 03-31 (cold exposure, mini-golf, Buzzkill), the Mar 2 pre-plunge files, and the Oct 22 to 23 Buzzkill sittings (one author, not the owner).
- **all**: every MuseLog recording on disk at least 3 min long. Reference pool.

A recording enters a pool only if the file is on disk, is at least 3 min long and yields at least 60 valid sequences (defined below). Counts are reported before results.

## Epochs and the gate (identical to the Buzzkill paper's tool)

2 s epochs on the 256 Hz raw. A channel's epoch is accepted when its contact value (HSI) is 2 or better, its peak-to-peak swing is under 200 µV and at least 90 % of the samples arrived. An epoch is usable when at least 2 of 4 channels are accepted. Band powers by Welch (256-sample segments, half overlap): theta 4 to 8, alpha 8 to 13, beta 13 to 30, gamma 30 to 44 Hz, log10. The target is the game's **activation index**, log10((beta + gamma) / (theta + alpha)), averaged over accepted channels. A secondary target is log alpha.

## Sequences, horizons, baselines

- History k = 8 epochs (16 s); horizons h = 1, 2, 4, 8 epochs (2, 4, 8, 16 s).
- A sequence is valid only if all k + h epochs are usable and contiguous in time (no gap). No imputation.
- Features: the 8 lagged index values, the 4 mean log band powers and the gyroscope RMS at the last epoch.
- Baselines: **persistence** (the last value) and the expanding **session mean**. Skill = 1 − MSE(model) / MSE(persistence). Skill against the session mean is reported too.
- Models, all local: ridge on the lags only (AR-8); ridge on all features; a small GRU (hidden 32) predicting the change from the last value. No cloud, no language model in the forecast.

## Protocols

- **A. Within a session, forward in time.** The first 60 % of a session's sequences train, the last 40 % test. One ridge per session. The GRU is not run here (too little data per session).
- **B. Across sessions.** Ridge: leave one session out within the pool. GRU: five folds grouped by session. **all → mine**: train on every non-owner session, test on each of the owner's sessions.
- Per horizon and model: n sequences, skill per session, the median across sessions, the pooled skill (1 − ΣSSE / ΣSSE), a 95 % interval from 2000 bootstrap resamples of sessions, and the share of sessions with positive skill.
- Null: 200 circular shifts of the test targets by at least 15 sequences; p = share of shifted skills at or above the observed pooled skill.
- Multiplicity: the primary cells are ridge-all-features, protocol A, pooled skill, h = 1..4, mine and cold. Everything else is secondary. Holm across the six primary cells.

## Predictions (each becomes supported or refuted by the run)

- **P1.** In the **mine** pool, protocol A, ridge-all at h = 1 (2 s): pooled skill against persistence between 0.05 and 0.30, interval excluding 0.
- **P2.** Skill decreases with horizon in every pool, and at h = 8 (16 s) the pooled skill is at most 0.05.
- **P3.** The GRU does not beat ridge-all by more than 0.05 pooled skill at any horizon in protocol B.
- **P4.** Cross-session ridge (B) is no better than within-session ridge (A) at h = 1 in the same pool (difference at most 0.03 in B's favour).
- **P5.** **all → mine** transfers: pooled skill at h = 1 on the owner's sessions is within 0.05 of B-within-mine.
- **P6.** The **cold** pool's pooled skill at h = 1 is within 0.10 of the **mine** pool's: predictability is a property of the signal, not of the condition.
- **P7.** Coverage, not skill, separates cold from calm: the share of usable epochs in the cold pool is lower than in the mine pool by at least 0.15.

## Amendments before the first run (2026-11-18, after the synthetic tests, before any recording was forecast)

- **The null.** The circular shift of targets credits any model that shrinks toward the mean, because persistence is a poor predictor of an unrelated series (seen on a synthetic AR(1): p = 1.0 for a model with real skill). Replaced by a within-session permutation of the **older** history: every target keeps its own current value (the newest lag, which is also the persistence value) and is paired with another sequence's earlier lags, band powers and motion; 200 permutations; p = share at or above the observed pooled skill. This asks the question that matters for anticipation: does 16 s of past add anything beyond the current level and regression toward the mean? (Permuting the whole history was tried first and is also wrong: it moves the current value too, so even white noise "beats" it.)
- **P2 restated.** Against persistence, skill need not fall with horizon: persistence itself degrades, so a model that regresses toward the mean gains on it (an AR(1) with coefficient 0.5 has more skill over persistence at 8 steps than at 1). The prediction that was meant is about information: **skill against the session mean falls with horizon and is at most 0.05 at h = 8** in every pool. Skill against persistence is still reported at every horizon as the number the game would use.

## What this does not test

Whether a plunge response can be predicted before the plunge. The owner has one marked pre-plunge sitting of 4 minutes; the other participants' before/after raw files are not on this laptop. That needs the marked protocol described in the project notes, not this run.

## The second half: a local language model proposes, the gate disposes

After the forecasting numbers exist, the local model (Ornith 9B via Ollama, nothing leaves the laptop) sees only aggregate tables: per-session statistics (pool, condition where the filename names one, usable fraction, mean index, mean band powers, motion) and the forecasting results. It is asked for claims in a fixed grammar: a comparison of two groups of sessions on one statistic, a correlation between two statistics across sessions, or a forecast-skill statement. Each claim is tested by a permutation test or read from the held-out forecasting results; groups under 5 sessions or correlations under 10 sessions are **abstain** (underpowered), Holm across all its claims. Tiers: supported (empirical), refuted, abstain, malformed. The ledger of proposed against surviving claims is the result. Nothing the model says is ever reported as more than the gate allows.
