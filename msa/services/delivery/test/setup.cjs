Object.assign(process.env,{NODE_ENV:'test',DB_HOST:'unused',DB_USER:'test',DB_PASSWORD:'test',DB_NAME:'unused',CUSTOMER_AUTH_TOKEN:'local-test-only-token-'.padEnd(40,'a')});
