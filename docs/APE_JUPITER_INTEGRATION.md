# ApeJupiter Integration for Kairos Meme Bot

Ce document explique comment l'intégration d'ApeJupiter (Ape Pro) a été implémentée dans le bot Kairos Meme pour améliorer le trading de memecoins sur Solana.

## Qu'est-ce qu'ApeJupiter?

ApeJupiter (également appelé Ape Pro) est un terminal de trading dédié aux memecoins sur Solana, lancé par l'équipe de Jupiter Exchange. Il offre:

- Une interface optimisée pour le trading de memecoins
- Des performances élevées et des flux en temps réel
- Une agrégation de liquidité de nombreux DEX/AMM de l'écosystème Solana
- Des fonctionnalités avancées comme le MEV-protected swapping (via Jito)
- L'affichage en temps réel des nouveaux tokens et des données de marché

Chaque swap effectué via ApeJupiter inclut des frais de plateforme de 0,5%.

## Fonctionnalités intégrées

L'intégration d'ApeJupiter dans le bot Kairos Meme apporte les fonctionnalités suivantes:

1. **Détection automatique des memecoins**: Le bot identifie automatiquement si un token est un memecoin et utilise ApeJupiter pour les swaps de memecoins.

2. **Protection MEV**: Les swaps sont protégés contre le MEV (Miner Extractable Value) grâce à l'intégration avec Jito.

3. **Fallback vers Jupiter standard**: Si un swap via ApeJupiter échoue, le bot peut automatiquement réessayer avec Jupiter standard.

4. **Optimisation pour les nouveaux tokens**: ApeJupiter est particulièrement efficace pour les nouveaux tokens avec peu de liquidité.

5. **Meilleure exécution pour les memecoins**: Routage optimisé spécifiquement pour les memecoins.

## Configuration

Les paramètres d'ApeJupiter peuvent être configurés dans le fichier `.env` ou directement dans `config.js`:

```
# ApeJupiter Settings
USE_APE_JUPITER=true                         # Activer/désactiver l'intégration ApeJupiter
APE_JUPITER_API_URL=https://lite-api.jup.ag/swap/v1  # URL de l'API ApeJupiter
APE_JUPITER_API_KEY=                         # Clé API (si disponible)
USE_MEV_PROTECTION=true                      # Activer la protection MEV via Jito
FALLBACK_TO_JUPITER=true                     # Fallback vers Jupiter standard si ApeJupiter échoue
PRIORITIZE_NEW_TOKENS=true                   # Prioriser les nouveaux tokens
MIN_TOKEN_AGE=3600                           # Âge minimum des tokens (en secondes)
APE_MAX_PRICE_IMPACT_PCT=10.0                # Impact de prix maximum autorisé
```

## Installation

Pour installer l'intégration ApeJupiter, exécutez le script d'installation:

```bash
./scripts/install-ape-jupiter.sh
```

Ce script va:
1. Ajouter les paramètres ApeJupiter à votre fichier `.env`
2. Installer les dépendances nécessaires
3. Créer les répertoires requis

## Utilisation

Une fois configuré, le bot utilisera automatiquement ApeJupiter pour les swaps de memecoins. Vous pouvez voir dans les logs quel fournisseur (ApeJupiter ou Jupiter standard) a été utilisé pour chaque swap.

Les transactions effectuées via ApeJupiter seront marquées avec `provider: 'apeJupiter'` dans la base de données.

## Avantages de l'intégration

- **Meilleure exécution pour les memecoins**: ApeJupiter est spécialement optimisé pour les memecoins, offrant souvent de meilleurs prix et une meilleure exécution.

- **Protection contre le MEV**: Réduit les risques de front-running et de sandwich attacks sur vos transactions.

- **Accès aux nouveaux tokens**: ApeJupiter a souvent accès aux nouveaux tokens plus rapidement que Jupiter standard.

- **Optimisation mobile**: Si vous utilisez le bot sur un appareil mobile, ApeJupiter offre une meilleure expérience.

## Limitations

- **Frais supplémentaires**: ApeJupiter prélève des frais de 0,5% sur chaque swap.

- **API potentiellement limitée**: L'API publique gratuite peut avoir des limites de taux plus strictes.

## Dépannage

Si vous rencontrez des problèmes avec l'intégration ApeJupiter:

1. Vérifiez les logs pour les erreurs spécifiques à ApeJupiter
2. Assurez-vous que l'URL de l'API est correcte et accessible
3. Essayez de désactiver temporairement ApeJupiter en définissant `USE_APE_JUPITER=false`
4. Vérifiez si le problème persiste avec Jupiter standard

## Ressources

- [Site officiel ApeJupiter](https://ape.pro)
- [Documentation Jupiter API](https://station.jup.ag/docs/apis/swap-api)
- [GitHub Jupiter](https://github.com/jup-ag)