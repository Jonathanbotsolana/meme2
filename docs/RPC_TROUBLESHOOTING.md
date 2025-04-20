# Guide de dépannage des problèmes RPC pour Kairos Meme Bot

Ce document explique comment résoudre les problèmes courants liés aux points d'accès RPC (Remote Procedure Call) Solana dans le bot Kairos Meme.

## Problèmes courants

### 1. Erreurs 429 (Too Many Requests)

**Symptômes :**
- Messages d'erreur "429 Too Many Requests" dans les logs
- Réponses Cloudflare indiquant une limitation de débit
- Messages "You are being rate limited"

**Solutions :**
- Réduire les paramètres `MAX_REQUESTS_PER_10_SEC` et `MAX_REQUESTS_PER_METHOD_10_SEC` dans votre fichier `.env`
- Activer le throttling avec `ENABLE_THROTTLING=true`
- Utiliser des endpoints RPC premium si possible
- Exécuter le script d'optimisation RPC : `./scripts/optimize-rpc-settings.sh`

### 2. Erreurs 403 (Forbidden)

**Symptômes :**
- Messages d'erreur "403 Forbidden" dans les logs
- Messages comme "API key is not allowed to access blockchain"

**Solutions :**
- Vérifier que vos clés API sont valides et correctement configurées
- Supprimer les endpoints qui nécessitent des clés API si vous n'en avez pas
- Utiliser des endpoints publics alternatifs

### 3. Erreurs 404 (Not Found)

**Symptômes :**
- Messages d'erreur "404 Not Found" dans les logs
- Endpoints qui ne répondent pas correctement

**Solutions :**
- Supprimer les endpoints obsolètes ou incorrects de votre configuration
- Mettre à jour les URLs des endpoints dans le fichier `config.js`

### 4. Erreurs de connexion

**Symptômes :**
- Messages "fetch failed" ou "connection refused"
- Timeouts fréquents

**Solutions :**
- Vérifier votre connexion internet
- Augmenter les délais de timeout et de retry dans la configuration
- Utiliser des endpoints plus fiables

## Comment optimiser vos paramètres RPC

1. **Exécutez le script de test RPC :**

```bash
node scripts/test-rpc-endpoints.js
```

Ce script testera tous les endpoints configurés et vous recommandera les plus fiables.

2. **Appliquez les optimisations automatiquement :**

```bash
./scripts/optimize-rpc-settings.sh
```

Ce script mettra à jour votre fichier `.env` avec des paramètres optimisés et testera les endpoints.

3. **Mettez à jour manuellement votre configuration :**

Modifiez le fichier `config.js` pour inclure uniquement les endpoints les plus fiables, en les classant par ordre de fiabilité.

## Utilisation d'endpoints RPC premium

Pour une fiabilité maximale, envisagez d'utiliser des services RPC premium comme :

- [QuickNode](https://www.quicknode.com/) (offre un plan gratuit limité)
- [Helius](https://helius.xyz/) (offre un plan gratuit limité)
- [Alchemy](https://www.alchemy.com/) (offre un plan gratuit limité)
- [Triton](https://triton.one/)

Pour configurer un endpoint premium :

1. Inscrivez-vous au service et obtenez votre URL d'endpoint et clé API
2. Ajoutez l'URL à votre fichier `.env` :
   ```
   SOLANA_RPC_URL=https://your-premium-endpoint.com/your-api-key
   ```
3. Redémarrez le bot : `pm2 restart kairos-meme-bot`

## Rotation des endpoints

Le bot Kairos Meme est configuré pour faire une rotation automatique entre les endpoints disponibles en cas d'échec. Vous pouvez améliorer ce comportement en :

1. Ajoutant plus d'endpoints fiables à votre configuration
2. Attribuant des niveaux de priorité appropriés (tiers) aux endpoints
3. Ajustant les paramètres de backoff pour les endpoints défaillants

## Vérification de l'état des endpoints

Pour vérifier l'état actuel de vos endpoints RPC, consultez les logs du bot :

```bash
pm2 logs kairos-meme-bot | grep "RPC health check"
```

Cela affichera les résultats des vérifications de santé périodiques des endpoints RPC.

## Ressources supplémentaires

- [Liste des endpoints RPC Solana publics](https://docs.solana.com/cluster/rpc-endpoints)
- [Documentation Solana sur les limites de débit RPC](https://docs.solana.com/developing/clients/jsonrpc-api#ratelimit)
- [Guide de dépannage Solana](https://docs.solana.com/developing/clients/jsonrpc-api#error-codes)