$lines = Get-Content src/api/routes/assistant.ts; for ($i=150; $i -lt 220; $i++) { "{0}:{1}" -f ($i+1), $lines[$i] }
