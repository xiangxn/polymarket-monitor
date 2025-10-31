curl --http1.1 -v -x "http://127.0.0.1:1087" -X POST "https://clob.polymarket.com/auth/api-key" \
  -H "POLY_ADDRESS: 0x0000001570BD7753dFCb42E1AD2E33D86eBA8870" \
  -H "POLY_SIGNATURE: 0x93790990c0281a7c4d490da884d32d23d74dc414bf89851db89d701cc4022a0d4312f4ae0a4ff8c184db38c52bf34a0b67b3a3b64bbd6c9d7c71282c6ab5df721b" \
  -H "POLY_TIMESTAMP: 1761841274" \
  -H "POLY_NONCE: 0" \
  -H "Content-Type: application/json" \
