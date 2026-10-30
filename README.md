# UML Class Helper (StarUML)

Génère le constructeur, les getters et les setters d'une classe dans StarUML (≥ 6), au format PHP.

## Installation

StarUML → **Tools → Extension Manager → Install From URL…** → coller :

```
https://github.com/underfr/uml-class-helper
```

Puis redémarrer StarUML.

## Utilisation

Sélectionner une classe (ou seulement certains attributs), puis clic droit → **UML Helpers**, ou `Cmd/Ctrl+Alt+G`.
**Generate for Whole Diagram** traite toutes les classes du diagramme ouvert.
**Check Diagram** liste les problèmes du diagramme ouvert (noms, types manquants, multiplicités, associations qui donnent le même attribut, méthodes orphelines ou non implémentées).
**Run Self-Test** (menu Tools) vérifie tous les comportements automatiques sur un modèle temporaire, de préférence dans un projet vide.

| Modèle | Généré |
|---|---|
| `-id: ?int` | `+getId(): ?int`, `+setId(id: ?int): void` |
| `-dateDebut: DateTime` | `+__construct(dateDebut: DateTime)`, getter, setter |
| `-actif: bool` | `+isActif(): bool` |
| `-code: string {readOnly}` | getter seulement |
| association vers `Absence` (côté `1` ou `0..1`) | `-absence: ?Absence`, `+getAbsence(): ?Absence`, `+setAbsence(absence: ?Absence): void` |
| composition vers `Moteur` (côté `1` ou `0..1`) | `-moteur: Moteur` (jamais null, donc sans `?` et dans le `__construct`), getter, setter |
| association vers `Produit` (côté `0..*`) | `-produits: array<Produit>`, `+getProduits()`, `+setProduits(produits: array<Produit>): void`, `+addProduit(produit: Produit): void`, `+removeProduit(produit: Produit): void` |
| classe qui implémente une interface / hérite d'une classe abstraite | copie des méthodes de l'interface / des méthodes abstraites |

- `__construct` : attributs non statiques dont le type ne commence pas par `?` (ni multiplicité `0..`/`*`).
- Associations : qui reçoit l'attribut ?
  1. flèche : la classe d'où part la flèche ;
  2. agrégation/composition : la classe côté losange (`Produit ◇── Categorie` → `categorie` dans Produit) ;
  3. association simple : le côté `0..*` reçoit le côté `1` ; sinon les deux.
  
  Rôle vide → nom de la classe, au pluriel côté `0..*` (pluriels réguliers ; sinon nommer le rôle).
  Plusieurs associations qui donneraient le même attribut (deux compositions `Chocoblast ◆── User` → `user`) : la génération demande un nom pour chacune, l'association concernée étant sélectionnée dans le diagramme (`target`, `blasted`), et l'enregistre comme nom de rôle.
- Héritage (`Employe ──▷ Personne`) : le `__construct` de l'enfant prend d'abord les paramètres du parent (`__construct(nom, prenom, salaire)`) ; getters/setters seulement pour ses propres attributs.
- Rien n'est dupliqué si on relance ; un `__construct` existant reçoit les nouveaux attributs, y compris ceux des classes filles ; un seul `Ctrl+Z` annule tout (un de plus si des noms de rôle ont été demandés).

## Automatique

- Toute nouvelle classe reçoit `-id: ?int` avec `getId()`/`setId()`.
- Ajouter un attribut crée son getter, son setter et son paramètre dans le `__construct` existant ; le renommer/typer ensuite met tout à jour.
- Changer le type d'un attribut (`-nom: string` → `-nom: int`) met à jour son getter, son setter et son paramètre de `__construct`. Passer en `?string` le retire du constructeur, repasser en `string` l'y remet.
- Renommer un attribut (`-nom` → `-test`) renomme `getNom`/`setNom`/`isNom` et le paramètre dans le setter et le `__construct`. Vers un nom d'attribut déjà pris : renommage annulé.
- Passer un type en `bool` renomme `getX` en `isX` (et inversement) ; cocher « static » rend ses méthodes statiques et le retire du `__construct`.
- Passer en `array<T>` ajoute `addX`/`removeX`, revenir en `?T` les supprime.
- Supprimer un attribut supprime son getter, son setter et son paramètre du `__construct` (2 `Ctrl+Z` pour tout récupérer).
- Supprimer une association supprime l'attribut qu'elle avait généré (`-categorie: ?Categorie`) et ses méthodes, y compris quand on supprime la classe à l'autre bout.
- Renommer une classe met à jour les types texte `?Ancien` → `?Nouveau` partout.
- Tracer un héritage retire le `-id` de l'enfant (le parent l'a déjà) et ajoute les paramètres du parent dans son `__construct` s'il existe.
- Ajouter, renommer, retyper ou supprimer un attribut du parent met aussi à jour le `__construct` des classes filles.
- Modifier une association (nom de rôle, multiplicité, flèche, losange, classe à un bout) renomme, retype ou déplace l'attribut qu'elle avait généré (`?Type` ↔ `array<Type>`, agrégation ↔ composition `?Type` ↔ `Type`, losange changé de côté…). Une association jamais générée n'est pas touchée.
- Supprimer un héritage retire les paramètres hérités du `__construct` de l'enfant (et de ses filles) et lui remet `-id: ?int`.
- Implémenter une interface copie ses méthodes dans la classe ; hériter d'une classe copie ses méthodes abstraites dans les filles concrètes. Renommer, modifier ou supprimer la méthode d'origine met à jour les copies.
