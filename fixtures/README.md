# NOVA 공개 샘플 3건

`nova-samples-2026/`은 사용자가 제공한 N.O.V.A. 2026 공개 샘플 ZIP에서 C01·C03·C10을 보존한 연습 자료입니다. 공개 샘플의 `case.json`, `case.md`, `model_record.json`, `model_record.md`를 포함하며, 실제 대회 평가 증례가 아닙니다.

`nova-samples-cases.json`은 `scripts/import_nova_samples.py`로 위 샘플을 CPX 가상 환자 저장 형식으로 변환한 결과입니다. 원문 대본과 모범 기록은 공개 샘플 검증용으로만 사용하고, 공식 대회 정답으로 간주하지 않습니다.

```bash
python scripts/import_nova_samples.py \
  /path/to/nova-samples-2026 \
  --output fixtures/nova-samples-cases.json
```

공개 대회 기준을 로컬 검증에도 적용합니다.

- 증례당 최대 50턴, SAY·EXAM 30 NFC 코드 포인트 이하
- 한 턴에 하나의 SAY/EXAM, 예선에서는 TEST 금지
- 확인한 내용만 S·O·A·P에 기록하고 DIAGNOSE로 주진단 하나 제출
- 평가 영역은 정보수집 25, 진단추론 15, 검사·추적 10, 안전 15, 의사소통 15, 효율 20

출처: [N.O.V.A. 2026 개발 가이드](https://nova.snubhai.org/docs/), [진행 및 평가](https://nova.snubhai.org/evaluation/), [참가 규칙](https://nova.snubhai.org/rules/).
