# Перенос позже

Когда `mikhailouskayanataliya-collab/Psihologist-cabinet` будет доступен токену Grok (collaborator Write + re-auth):

1. Проверить: API не отдаёт 404 на целевой repo
2. Push всех файлов из `portal/` или mirror:

```bash
git clone https://github.com/A1Dmitry/Psihologist-cabinet.git
cd Psihologist-cabinet
git remote add collab https://github.com/mikhailouskayanataliya-collab/Psihologist-cabinet.git
git push collab main
```
