# incident-proofs

Tek koşulabilir harness: 3 belgelenmiş çift-yan-etki vakasını yeniden üretir ve GNL'in her birini
engellediğini gösterir. Her vaka için gerçek bir `runDurable`/`resumeRun` çalıştırması var — iddia değil,
konsoldan okunan kanıt.

## Çalıştır
```bash
cd ../.. && pnpm -r build   # önce paketleri derle (workspace link'leri dist'e işaret ediyor)
cd examples/incident-proofs
pnpm install
pnpm proofs
```
API key gerekmez — deterministik mock model kullanılır.

## Vakalar
| # | Vaka | Kök neden | Dosya |
|---|---|---|---|
| 1 | duplicate-toolcall-ids | model aynı tool'u aynı argümanlarla, tek turda, FARKLI toolCallId'lerle 5 kez çağırıyor | `src/duplicate-toolcall-ids.ts` |
| 2 | checkpoint-resend | 180sn+ tool call, checkpoint'ten crash sonrası sessizce yeniden gönderiliyor | `src/checkpoint-resend.ts` |
| 3 | double-approval | onay olayı iki kez işleniyor, tool onay sonrası iki kez çalışıyor | `src/double-approval.ts` |

Her dosyada iki koşum var: **korumasız** (varsayılan/naif yol — kaç kez çalıştığını gösterir) ve
**GNL ile** (`idempotency: 'args'`, `runDurable` + aynı `runId` ile resume, veya `resumeRun` — kaç kez
çalıştığını gösterir). `src/report.ts` ikisini yan yana bir tabloya basar.
