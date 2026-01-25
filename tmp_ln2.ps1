$lines = Get-Content src/api/routes/assistant.ts; for ($i=220; $i -lt 360; $i++) { "{0}:{1}" -f ($i+1), $lines[$i] }
