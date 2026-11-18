# A local model proposes, the gate disposes

Model: ornith:9b through Ollama, on this laptop, 30 s, temperature 0.7, JSON mode. It saw the briefing in `results/proposals/prompt.txt` (column dictionary, counts, group means, the forecast summary) and nothing else. 12 claims parsed from its reply.

| # | claim | outcome | tier | numbers |
|---|---|---|---|---|
| 1 | usable_fraction in mine/any > cold/any | malformed | malformed | {"reason": "groups overlap on 2 sessions"} |
| 2 | gyro_rms_mean - usable_fraction across all | not_supported | inconclusive at this n | {"rho": -0.07337271943211592, "p_stated": 0.2552744725527447, "p_opposite": 0.7449255074492551, "n": 78, "p_stated_holm": 0.2552744725527447, "p_opposite_holm": 1.0} |
| 3 | mean_logbeta + mean_loggamma across all | supported | empirical | {"rho": 0.9663933596517866, "p_stated": 9.999000099990002e-05, "p_opposite": 1.0, "n": 39, "p_stated_holm": 0.00039996000399960006, "p_opposite_holm": 1.0} |
| 4 | gyro_rms_mean in mine/any < cold/any | malformed | malformed | {"reason": "groups overlap on 2 sessions"} |
| 5 | mean_index in mine/any > mine_sleep/sleep | abstain | abstain | {"reason": "underpowered: n_a=7, n_b=1 (need 5 each)"} |
| 6 | ridge_all on mine/A h=1: skill >= 0.2 | supported | empirical | {"pooled_skill": 0.39275765047272293, "ci": [0.11927898817108129, 0.5066605503615746], "sessions": 6, "min_skill": 0.2} |
| 7 | ridge_all on mine/A h=4: skill >= 0.2 | supported | empirical | {"pooled_skill": 0.45005551836212765, "ci": [0.28649954390536847, 0.5281993153853506], "sessions": 6, "min_skill": 0.2} |
| 8 | ridge_all on cold/A h=1: skill >= -0.1 | not_supported | inconclusive at this n | {"pooled_skill": 0.15503180459336496, "ci": [-0.0775343920923646, 0.34695102985341897], "sessions": 6, "min_skill": -0.1} |
| 9 | mean_index + mean_logbeta across all | supported | empirical | {"rho": 0.5657455208017005, "p_stated": 0.00019998000199980003, "p_opposite": 0.9999000099990001, "n": 39, "p_stated_holm": 0.00039996000399960006, "p_opposite_holm": 1.0} |
| 10 | mean_logalpha in mine/any < cold/any | malformed | malformed | {"reason": "groups overlap on 2 sessions"} |
| 11 | ridge_all on all/A h=4: skill >= 0.2 | supported | empirical | {"pooled_skill": 0.24879316887577885, "ci": [0.030489945013787136, 0.4609451013744576], "sessions": 12, "min_skill": 0.2} |
| 12 | gyro_rms_mean + mean_logtheta across all | supported | empirical | {"rho": 0.7857142857142855, "p_stated": 9.999000099990002e-05, "p_opposite": 1.0, "n": 29, "p_stated_holm": 0.00039996000399960006, "p_opposite_holm": 1.0} |

## Count

| proposed | supported | refuted | not supported | abstain | malformed |
|---|---|---|---|---|---|
| 12 | 6 | 0 | 2 | 1 | 3 |

Supported means the stated direction survives a permutation test with Holm correction across every claim the model made (or, for a forecast claim, the held-out interval clears the stated skill). Nothing here is verified in the exact sense; the best tier is empirical. The rationale the model gave for each claim is in the ledger.
