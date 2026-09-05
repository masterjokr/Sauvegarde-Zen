# Sauvegarde Zen

Application Electron pour Windows permettant de sauvegarder un dossier vers un autre disque, manuellement ou selon plusieurs horaires.

## Ce que fait la V1.2.0

- plusieurs profils source → destination ;
- plusieurs horaires par profil : toutes les X heures, chaque jour, ou plusieurs jours de la semaine ;
- lancement manuel en un clic ;
- rappel quotidien ou hebdomadaire par notification Windows ;
- copie incrémentale : seuls les fichiers absents ou dont la taille/date de modification a changé sont copiés ;
- aucune suppression dans la destination ;
- avant de remplacer un fichier modifié, l’ancienne copie est déplacée dans `.sauvegarde-zen/versions/<id>/<date>/` au sein de la destination. Il s’agit d’archives **fichier par fichier**, pas de copies complètes du projet ;
- conservation automatique des **3 dernières séries de fichiers archivés** par profil : les séries plus anciennes sont supprimées automatiquement, sans toucher aux fichiers actuels de la destination ;
- consultation des fichiers conservés et restauration d’un fichier depuis l’interface ;
- zone de sécurité temporaire pour la copie remplacée lors d’une restauration, elle aussi limitée aux 3 dernières opérations ;
- exclusions facultatives par motif (par exemple `node_modules`, `*.tmp`, `cache/**`) ;
- vérification de l’accès aux dossiers, indication des disques utilisés et de l’espace libre disponible ;
- progression de l’analyse et de la copie avec nombre de fichiers et estimation du temps restant ;
- vérification des mises à jour GitHub depuis les réglages, avec téléchargement automatique des nouvelles releases ;
- historique local des 200 dernières exécutions ;
- fonctionnement en arrière-plan dans la zone de notification ;
- démarrage facultatif avec Windows dans la version installée.

Les liens symboliques et fichiers spéciaux sont ignorés. Le dossier interne `.sauvegarde-zen` est réservé à l’application et n’est pas recopié depuis la source. Les sauvegardes planifiées et rappels nécessitent que l’application soit active ; il est donc conseillé d’activer « Démarrer avec Windows ».

## Prérequis

- Windows 10 ou 11 en 64 bits ;
- Node.js 20 LTS ou supérieur pour le mode développement ;
- deux dossiers accessibles en lecture/écriture.

Le projet est configuré avec Electron 44.1.1 et electron-builder 26.15.3.

## Lancement en développement

Dans PowerShell, depuis ce dossier :

```powershell
npm install
npm start
```

## Mises à jour via GitHub

Les mises à jour automatiques utilisent les **GitHub Releases** et l’installateur
Windows NSIS. Le bouton **Rechercher une mise à jour** se trouve dans
**Réglages**. Une mise à jour téléchargée est installée à la fermeture ou au
redémarrage de l’application.

Le dépôt doit contenir le dossier `.github/workflows/release.yml`. Pour publier
une nouvelle version :

1. Modifier le numéro `version` dans `package.json` (par exemple `1.2.1`).
2. Envoyer les modifications sur GitHub.
3. Créer et pousser un tag correspondant, par exemple `v1.1.2`.
4. GitHub Actions lance les tests, construit l’installateur et crée la Release.

```powershell
git add .
git commit -m "Version 1.2.1"
git push
git tag v1.2.1
git push origin v1.2.1
```

Les utilisateurs installés ne téléchargent jamais le code source : ils reçoivent
uniquement l’installateur et ses fichiers de mise à jour publiés dans la Release.
Pour que la vérification automatique fonctionne, l’application distribuée doit
être construite avec la cible NSIS (`npm run release:win` dans GitHub Actions) ;
la version portable reste destinée aux tests ou à un usage sans installation.

Pour une première configuration simple, utilisez un dépôt GitHub **public**.
Le workflow récupère automatiquement le propriétaire et le nom du dépôt dans
GitHub Actions. Si le projet est seulement copié dans GitHub par glisser-déposer,
la publication de la Release doit tout de même être déclenchée avec un tag `vX.Y.Z`
comme indiqué ci-dessus.

## Tests automatisés

```powershell
npm test
```

Les tests contrôlent la première copie, l’incrémental, la conservation des fichiers supprimés de la source, l’historisation et la rétention des versions, la restauration, les exclusions, les horaires et la validation des chemins.

## Création de l’installateur Windows

```powershell
npm install
npm run package:win
```

L’installateur NSIS sera créé dans `dist/`. Une variante portable peut être produite avec :

```powershell
npm run package:win:portable
```

## Vérification manuelle conseillée

1. Créer deux dossiers de test sur deux disques, par exemple `C:\TestSource` et `D:\TestSauvegarde`.
2. Ajouter quelques fichiers dans la source.
3. Créer un profil puis cliquer sur **Lancer** : les fichiers doivent apparaître dans la destination.
4. Relancer sans changement : le journal doit indiquer les fichiers comme inchangés et `0` fichier copié.
5. Modifier un fichier source puis relancer : la destination reçoit la nouvelle version et l’ancienne se trouve sous `.sauvegarde-zen\versions`.
6. Modifier un même fichier au moins quatre fois : seules les 3 versions les plus récentes restent dans **Versions** ; l’ancienne est supprimée automatiquement.
7. Ouvrir **Versions**, puis cliquer sur **Restaurer** pour remettre une ancienne copie. La copie actuelle est conservée dans `.sauvegarde-zen\restore-safety`.
8. Ajouter une exclusion comme `*.tmp`, créer un fichier temporaire et vérifier qu’il n’est pas copié.
9. Supprimer un fichier de la source puis relancer : sa copie reste présente dans la destination.
10. Ajouter un horaire proche et vérifier l’exécution et la notification, application réduite dans la zone de notification.

## Sécurité

La fenêtre Electron utilise `contextIsolation`, désactive l’intégration Node dans l’interface, active le bac à sable, applique une politique CSP et n’expose au renderer qu’une API IPC limitée. Aucun service en ligne ni compte n’est utilisé : la configuration et l’historique restent dans le dossier de données local de l’application.

## Arborescence

```text
main/
  main.js             Cycle de vie Electron et IPC
  backup-engine.js    Moteur de copie incrémentale
  version-store.js     Rétention et restauration des versions
  storage.js           Vérification des dossiers et de l’espace libre
  backup-manager.js   Exécutions et historique
  scheduler.js        Horaires et rappels
  config-store.js     Persistance JSON atomique
  validation.js       Validation des données et chemins
preload/
  preload.js           API minimale exposée à l’interface
renderer/
  index.html
  styles.css
  app.js
tests/
```

## Limites connues

La détection d’un fichier modifié repose sur sa taille et sa date de dernière modification, ce qui est le comportement incrémental le plus simple et rapide. Un futur mode « vérification approfondie » pourrait ajouter un hash SHA-256 pour détecter un changement dont la taille et la date auraient été volontairement conservées à l’identique.
