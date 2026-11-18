# A local model proposes, the gate disposes (blind round: the forecast numbers withheld)

Model: ornith:9b through Ollama, on this laptop, 32 s, temperature 0.7, JSON mode. It saw the briefing in `results/proposals_blind/prompt.txt` (column dictionary, counts, group means, no forecast numbers) and nothing else. 12 claims parsed from its reply.

| # | claim | outcome | tier | numbers |
|---|---|---|---|---|
| 1 | usable_fraction in mine/any > cold/any | malformed | malformed | {"reason": "groups overlap on 2 sessions"} |
| 2 | gyro_rms_mean - usable_fraction across all | not_supported | inconclusive at this n | {"rho": -0.07337271943211592, "p_stated": 0.2552744725527447, "p_opposite": 0.7449255074492551, "n": 78, "p_stated_holm": 1.0, "p_opposite_holm": 1.0} |
| 3 | mean_logalpha + mean_logtheta across all | supported | empirical | {"rho": 0.8896649458447211, "p_stated": 9.999000099990002e-05, "p_opposite": 1.0, "n": 39, "p_stated_holm": 0.0006999300069993001, "p_opposite_holm": 1.0} |
| 4 | mean_logbeta + mean_loggamma across all | supported | empirical | {"rho": 0.9663933596517866, "p_stated": 9.999000099990002e-05, "p_opposite": 1.0, "n": 39, "p_stated_holm": 0.0006999300069993001, "p_opposite_holm": 1.0} |
| 5 | mean_index in mine/any > cold/any | malformed | malformed | {"reason": "groups overlap on 2 sessions"} |
| 6 | mean_logalpha in mine/any < cold/any | malformed | malformed | {"reason": "groups overlap on 2 sessions"} |
| 7 | minutes + usable_fraction across all | not_supported | inconclusive at this n | {"rho": 0.11761002149879202, "p_stated": 0.10288971102889712, "p_opposite": 0.8972102789721028, "n": 115, "p_stated_holm": 0.5144485551444856, "p_opposite_holm": 1.0} |
| 8 | mean_logalpha in mine_sleep/any < all/any | malformed | malformed | {"reason": "groups overlap on 1 sessions"} |
| 9 | gyro_rms_mean - mean_index across all | not_supported | inconclusive at this n | {"rho": -0.10689655172413792, "p_stated": 0.2953704629537046, "p_opposite": 0.7058294170582942, "n": 29, "p_stated_holm": 1.0, "p_opposite_holm": 1.0} |
| 10 | usable_fraction in mine/any < mine_sleep/any | abstain | abstain | {"reason": "underpowered: n_a=14, n_b=1 (need 5 each)"} |
| 11 | mean_logbeta - mean_logalpha across all | refuted | refuted | {"rho": 0.7550359348112157, "p_stated": 1.0, "p_opposite": 9.999000099990002e-05, "n": 39, "p_stated_holm": 1.0, "p_opposite_holm": 0.0006999300069993001} |
| 12 | mean_loggamma - mean_logalpha across all | refuted | refuted | {"rho": 0.6489523231096264, "p_stated": 1.0, "p_opposite": 9.999000099990002e-05, "n": 39, "p_stated_holm": 1.0, "p_opposite_holm": 0.0006999300069993001} |

## Count

| proposed | supported | refuted | not supported | abstain | malformed |
|---|---|---|---|---|---|
| 12 | 2 | 2 | 3 | 1 | 4 |

Supported means the stated direction survives a permutation test with Holm correction across every claim the model made (or, for a forecast claim, the held-out interval clears the stated skill). Nothing here is verified in the exact sense; the best tier is empirical. The rationale the model gave for each claim is in the ledger.
