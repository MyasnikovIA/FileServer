#!/bin/sh
echo $(( ($(date -d "$(sudo openssl x509 -enddate -noout -in /etc/letsencrypt/live/smwrap.ru/fullchain.pem | cut -d= -f2)" +%s) - $(date +%s)) / 86400 )) дней
